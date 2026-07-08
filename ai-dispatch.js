/*  ai-dispatch.js  — Multi-provider AI dispatcher (shared)
 *  Extracted from js/ai-chat.js so both War Room Scout and War Room can use it.
 *  Exposes: PROVIDERS, updateProviderHint, hasServerAI, hasAnyAI,
 *           callClaude, callGrokNews
 *  Globals expected: window.S (state), window.OD (Supabase/server-side),
 *    window.$ (DOM helper), window.DHQ_IDENTITY, window.DHQ_PROMPTS
 */
window.App = window.App || {};

(function() {
'use strict';

// ── AI Provider config ───────────────────────────────────────
const AI_POLICY_VERSION = '2026-05-03.vendor-router.v1';
const AI_MODELS = {
  GEMINI_FAST: 'gemini-2.5-flash-lite',
  GEMINI_BALANCED: 'gemini-2.5-flash',
  OPENAI_FAST: 'gpt-5.4-nano',
  OPENAI_STANDARD: 'gpt-5.4-mini',
  OPENAI_PREMIUM: 'gpt-5.5',
  CLAUDE_REASONING: 'claude-sonnet-4-6',
  CLAUDE_DEEP: 'claude-opus-4-7',
};

const AI_TIER_MODELS = {
  fast: { gemini: AI_MODELS.GEMINI_FAST, openai: AI_MODELS.OPENAI_FAST },
  standard: { gemini: AI_MODELS.GEMINI_BALANCED, openai: AI_MODELS.OPENAI_STANDARD },
  premium: { anthropic: AI_MODELS.CLAUDE_REASONING, openai: AI_MODELS.OPENAI_PREMIUM },
  deep: { anthropic: AI_MODELS.CLAUDE_DEEP },
};

const DEFAULT_PROVIDER_BY_TIER = {
  fast: 'gemini',
  standard: 'gemini',
  premium: 'anthropic',
  deep: 'anthropic',
};

const PROVIDERS = {
  gemini: {
    name: 'Gemini Flash',
    placeholder: 'AIza...',
    hint: 'Low-cost default at <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com</a>. Good for Alex summaries and quick Q&A. No web search.',
    defaultModel: AI_MODELS.GEMINI_FAST,
    validate: k => k.length > 10,
  },
  openai: {
    name: 'OpenAI',
    placeholder: 'sk-...',
    hint: 'Paid OpenAI key. Uses GPT-5.4 Mini by default for BYO standard analysis; GPT-5.5 is available as a manual premium model override.',
    defaultModel: AI_MODELS.OPENAI_STANDARD,
    validate: k => k.startsWith('sk-'),
  },
  anthropic: {
    name: 'Claude (Anthropic)',
    placeholder: 'sk-ant-...',
    hint: 'Get your key at <a href="https://console.anthropic.com" target="_blank">console.anthropic.com</a>. Supports web search.',
    defaultModel: AI_MODELS.CLAUDE_REASONING,
    validate: k => k.startsWith('sk-'),
  },
};

const AI_ROUTES = {
  // Home chat is Alex's flagship conversational surface and carries the richest
  // persona instructions — it needs a model that can actually hold the voice, so
  // it runs on standard (still Gemini-balanced, still inexpensive), matching the
  // hosted edge-function route for the same surface.
  'home-chat': 'standard',
  // Background/utility surfaces stay on the cheapest tier.
  'memory-summary': 'fast',
  'power-posts': 'fast',
  'recon-chat': 'fast',
  // Normal analysis uses the standard price/performance tier.
  'waiver-chat': 'standard',
  'waiver-agent': 'standard',
  'draft-chat': 'standard',
  'strategy-analysis': 'standard',
  // Deep reasoning is explicit premium usage.
  'trade-chat': 'premium',
  'trade-scout': 'premium',
  'draft-scout': 'premium',
  'pick-analysis': 'premium',
  'player-scout': 'premium',
  'deep-analysis': 'deep',
  'league-report': 'deep',
  'rule-simulator': 'deep',
  'trade-audit': 'deep',
};

function routeForTier(tier, provider) {
  const preferred = provider || DEFAULT_PROVIDER_BY_TIER[tier] || DEFAULT_PROVIDER_BY_TIER.standard;
  const model = AI_TIER_MODELS[tier]?.[preferred]
    || AI_TIER_MODELS[tier]?.[DEFAULT_PROVIDER_BY_TIER[tier]]
    || AI_TIER_MODELS.standard.gemini;
  const resolvedProvider = AI_TIER_MODELS[tier]?.[preferred] ? preferred : (DEFAULT_PROVIDER_BY_TIER[tier] || 'gemini');
  return { provider: resolvedProvider, model, tier };
}

function routeForType(type) {
  return routeForTier(AI_ROUTES[type] || 'standard');
}

const MODEL_ROUTING = Object.fromEntries(
  Object.entries(AI_ROUTES).map(([type, tier]) => [type, routeForTier(tier)])
);

// ── Provider hint UI helper ──────────────────────────────────
function updateProviderHint(){
  const sel=(window.$||document.getElementById.bind(document))('ai-provider-sel');if(!sel)return;
  const prov=sel.value;
  const hints={
    gemini:{text:'Gemini Flash — low cost, fast Alex responses',color:'var(--green)'},
    openai:{text:'OpenAI — strong BYO option for GPT-5.4 Mini or manual GPT-5.5 premium use',color:'var(--blue, var(--accent))'},
    anthropic:{text:'Claude Sonnet — best quality, requires paid API key',color:'var(--accent)'},
  };
  const h=hints[prov]||{text:'',color:'var(--text3)'};
  const el=(window.$||document.getElementById.bind(document))('provider-hint');
  if(el){el.textContent=h.text;el.style.color=h.color;}
}

function isLocalPreviewAI(){
  const cfg = window.App?.CONFIG || window.OD?.CONFIG || {};
  const endpoint = cfg.endpoints?.aiAnalyze || window.OD?.BACKEND_ENDPOINTS?.aiAnalyze || '';
  const host = window.location?.hostname || '';
  return !!(
    cfg.devPreviewAI
    && window.OD?.callAI
    && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)
    && /\/api\/dev-ai-analyze(?:$|\?)/.test(String(endpoint))
  );
}

// ── Helper: check if server-side AI is available ─────────────
function hasServerAI(){
  const token = window.OD?.getSessionToken?.();
  return !!(window.OD?.callAI && (token || isLocalPreviewAI()));
}

// ── Helper: check if ANY AI is available (server or client key) ─
function hasAnyAI(showPrompt=false){
  const S = window.S || window.App?.S || {};
  // BYOK users always have AI access — skip paywall for them
  if (S.apiKey) return true;
  // Server-side AI available
  if (hasServerAI()) return true;
  // No key, no server — check paywall before showing prompt
  if (typeof canAccess === 'function' && !canAccess('ai-unlimited')) {
    if (showPrompt && typeof showUpgradePrompt === 'function') {
      const containers = ['home-chat-msgs','trade-chat-msgs','wq-chat-msgs','draft-msgs'];
      const el = containers.map(id => document.getElementById(id)).find(e => e && e.offsetParent !== null);
      if (el) showUpgradePrompt('ai-unlimited', el);
    }
    return false;
  }
  return false;
}

function trackAIEvent(eventName, payload = {}) {
  try {
    window.OD?.track?.(eventName, {
      platform: window.location.pathname.includes('warroom') ? 'warroom' : 'reconai',
      module: payload.module || window.S?.activeTab || window.App?.activeTab || null,
      durationMs: payload.durationMs,
      entityType: 'ai_call',
      entityId: payload.callType || null,
      metadata: {
        callType: payload.callType || null,
        provider: payload.provider || null,
        model: payload.model || null,
        aiPolicyVersion: AI_POLICY_VERSION,
        routeTier: payload.routeTier || null,
        server: !!payload.server,
        byok: !!payload.byok,
        useWebSearch: !!payload.useWebSearch,
        success: payload.success,
        errorType: payload.errorType || null,
        inputTokens: payload.usage?.inputTokens || payload.usage?.input_tokens || null,
        outputTokens: payload.usage?.outputTokens || payload.usage?.output_tokens || null,
        costUsd: payload.usage?.costUsd || payload.usage?.cost_usd || null,
      },
    });
  } catch (_err) {}
}

// Best-effort structured league/team context for the server's generic-path
// enrichment (AI_GENERIC_ENRICH). Mirrors the field names ai-analyze's
// detectLeagueFormat / buildTeamModeBlock read. Returns {} when state is
// unavailable so callClaude never throws on this.
function dhqServerEnrichmentFields(){
  try {
    const S = window.S || window.App?.S || {};
    const league = S.leagues?.find(l => l.league_id === S.currentLeagueId) || S.leagues?.[0] || null;
    const assess = (typeof assessTeamFromGlobal === 'function')
      ? assessTeamFromGlobal(S.myRosterId)
      : (typeof window.assessTeamFromGlobal === 'function' ? window.assessTeamFromGlobal(S.myRosterId) : null);
    const out = {};
    if (league?.roster_positions) out.rosterPositions = league.roster_positions;
    if (league?.scoring_settings) out.scoringSettings = league.scoring_settings;
    if (assess?.tier) out.teamTier = assess.tier;
    if (assess?.window) out.teamWindow = assess.window;
    if (typeof assess?.healthScore === 'number') out.healthScore = assess.healthScore;
    return out;
  } catch (e) { return {}; }
}

// ── Core AI call ──────────────────────────────────────────────
// Priority: 1) Server-side via OD.callAI (no user key needed)
//           2) Client-side via user's API key (existing behavior)
async function callClaude(messages, useWebSearch=false, _retries=2, maxTok=600, callType=null){
  // Smart model routing: if callType is set AND user has the required API key, route to optimal model
  // If user has manually set a provider/model in settings, respect that (user override)
  const S = window.S || window.App?.S || {};
  const userOverride = S.aiProvider && S.apiKey; // user explicitly configured a provider

  // ── Free-tier cost clamp (single COGS chokepoint) ─────────────
  // Every Scout AI surface funnels through callClaude. Free users (no BYOK
  // key) never reach premium/deep models or web search regardless of the
  // call type — so clamping here closes all premium/web-search cost leaks at
  // once and survives future call sites. The per-surface depth gates remove
  // the buttons; this is the belt-and-suspenders server-cost backstop. The
  // server (OD.callAI) routes by `type`, so we downgrade the type itself.
  const _freeTier = !userOverride && !S.apiKey
    && typeof getTier === 'function' && getTier() === 'free';
  if (_freeTier) {
    useWebSearch = false;
    const t = callType ? AI_ROUTES[callType] : null;
    if (t === 'premium' || t === 'deep') callType = 'recon-chat'; // cheapest tier
  }

  let effectiveProvider, effectiveModel, routeTier;
  if (userOverride) {
    // User set their own key — use their choice
    effectiveProvider = S.aiProvider;
    effectiveModel = S.aiModel || PROVIDERS[S.aiProvider]?.defaultModel;
    routeTier = AI_ROUTES[callType] || null;
  } else if (callType) {
    // Smart routing — pick the configured tier for this task
    const route = routeForType(callType);
    effectiveProvider = route.provider;
    effectiveModel = route.model;
    routeTier = route.tier;
  } else {
    effectiveProvider = S.aiProvider || 'gemini';
    effectiveModel = S.aiModel || PROVIDERS[effectiveProvider]?.defaultModel;
    routeTier = null;
  }

  // Web search only available on Anthropic — fall back if needed
  if (useWebSearch && effectiveProvider !== 'anthropic') {
    effectiveProvider = 'anthropic';
    effectiveModel = PROVIDERS.anthropic.defaultModel;
    routeTier = routeTier === 'deep' ? 'deep' : 'premium';
  }

  const sys = (typeof DHQ_IDENTITY !== 'undefined') ? DHQ_IDENTITY : 'Dynasty FF advisor. Values from DHQ (0-10000 scale, league-derived). Be specific with player names and DHQ values. NEVER recommend players with DHQ < 500 or under 5.0 PPG (6+ games); if no quality targets exist, say "HOLD YOUR FAAB" rather than inventing one. Sleeper-ready messages when asked.';
  const analyticsType = callType || 'recon-chat';
  const aiStartedAt = Date.now();
  trackAIEvent('alex_prompt_sent', {
    callType: analyticsType,
    provider: effectiveProvider,
    model: effectiveModel,
    routeTier,
    useWebSearch,
  });
  const finishAI = (reply, extra = {}) => {
    trackAIEvent('alex_response_received', {
      callType: analyticsType,
      provider: effectiveProvider,
      model: effectiveModel,
      routeTier,
      useWebSearch,
      durationMs: Date.now() - aiStartedAt,
      success: true,
      ...extra,
    });
    return reply;
  };

  // ── SERVER-SIDE PATH: use OD.callAI Edge Function ──────────
  // Available when user has a Supabase session (no API key required)
  if(hasServerAI()){
    try{
      // Build a single context string from the messages array
      const lastUserMsg = [...messages].reverse().find(m=>m.role==='user');
      const effectiveType = callType || 'recon-chat';
      const result = await window.OD.callAI({
        type: effectiveType,
        context: JSON.stringify({
          system: sys,
          messages: messages,
          callType: effectiveType,
          userMessage: lastUserMsg?.content || '',
          maxTokens: maxTok,
          useWebSearch: useWebSearch,
          // Additive structured context for the server's generic-path enrichment
          // (AI_GENERIC_ENRICH). Lets ai-analyze build the same league-format /
          // team-mode / quality blocks the structured path gets. Older servers
          // ignore unknown fields, so this is safe to send unconditionally.
          ...dhqServerEnrichmentFields(),
        }),
      });
      const reply = result?.analysis || result?.response || result?.text ||
        (typeof result === 'string' ? result : JSON.stringify(result));
      // Expose usage for UI (rate limit indicator)
      if(result?.usage){
        window.App.aiUsage = result.usage;
        window.dispatchEvent(new CustomEvent('ai-usage-updated', { detail: result.usage }));
      }
      // Cache the response in Supabase
      if(window.OD.saveAIAnalysis && S.currentLeagueId){
        window.OD.saveAIAnalysis(
          S.currentLeagueId,
          effectiveType,
          (lastUserMsg?.content||'').substring(0,200),
          reply
        ).catch(()=>{}); // fire and forget
      }
      return finishAI(reply || 'No response.', {
        server: true,
        provider: result?.provider || effectiveProvider,
        model: result?.model || effectiveModel,
        routeTier: result?.usage?.routeTier || null,
        usage: result?.usage,
      });
    }catch(serverErr){
      // Rate limit — show clear message, don't fall back to BYOK
      if(serverErr.message && serverErr.message.includes('Daily limit reached')){
        // Expose usage from error if available
        if(serverErr.usage) window.App.aiUsage = serverErr.usage;
        trackAIEvent('alex_response_error', {
          callType: analyticsType,
          provider: effectiveProvider,
          model: effectiveModel,
          useWebSearch,
          durationMs: Date.now() - aiStartedAt,
          success: false,
          server: true,
          usage: serverErr.usage,
          errorType: 'rate_limit',
        });
        throw new Error(serverErr.message);
      }
      console.warn('[ai-dispatch] Server AI failed, falling back to client:', serverErr.message);
      // High-frequency, low-stakes per-pick draft reactions must never double-dip
      // (a failed server attempt followed by the whole client retry loop). Fail fast
      // so a pick reaction is at most one round-trip; the rule-based stream line covers it.
      if(callType === 'pick-analysis') throw serverErr;
      // Fall through to client-side if user has an API key
      if(!S.apiKey) throw serverErr;
    }
  }

  // ── CLIENT-SIDE PATH: direct API calls with user's key ─────
  if(!S.apiKey) throw new Error('No AI available. Connect your account or add an API key in Settings.');

  // Fallback: if saved provider was removed (groq/grok), default to gemini
  const provider = PROVIDERS[effectiveProvider] ? effectiveProvider : 'gemini';
  const apiKey = S.apiKey;
  const model = effectiveModel || PROVIDERS[provider]?.defaultModel || AI_MODELS.CLAUDE_REASONING;
  // Web search only works with Anthropic — silently disable for other providers
  if(provider !== 'anthropic') useWebSearch = false;

  for(let attempt=0; attempt<=_retries; attempt++){
    let res, data;
    try{
      if(provider === 'anthropic'){
        const body = {model, max_tokens:maxTok, system:sys, messages};
        if(useWebSearch){body.tools=[{type:'web_search_20250305',name:'web_search'}];body.max_tokens=Math.max(maxTok,1500);}
        const headers = {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'};
        if(useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';
        res = await fetch('https://fragrant-brook-c770.jacobcrusinberry.workers.dev/', {method:'POST', headers, body:JSON.stringify(body)});
        if((res.status===429||res.status===529)&&attempt<_retries){await new Promise(r=>setTimeout(r,(attempt+1)*10000));continue;}
        if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||'API error '+res.status);}
        data = await res.json();
        if(data.error) throw new Error(data.error.message||'API error');
        const reply = (data.content||[]).filter(c=>c.type==='text').map(c=>c.text||'').join('') || 'No response.';
        return finishAI(reply, { server: false, byok: true, usage: data.usage });

      } else if(provider === 'gemini'){
        const body = {model, max_completion_tokens:maxTok, messages:[{role:'system',content:sys},...messages]};
        res = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey}, body:JSON.stringify(body)});
        if((res.status===429)&&attempt<_retries){await new Promise(r=>setTimeout(r,(attempt+1)*10000));continue;}
        if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||'API error '+res.status);}
        data = await res.json();
        if(data.error) throw new Error(data.error.message||'Gemini error');
        return finishAI(data.choices?.[0]?.message?.content || 'No response.', { server: false, byok: true, usage: data.usage });

      } else if(provider === 'openai'){
        const body = {
          model,
          instructions: sys,
          input: messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || '' })),
          max_output_tokens: maxTok,
        };
        res = await fetch('https://api.openai.com/v1/responses', {method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+apiKey}, body:JSON.stringify(body)});
        if((res.status===429)&&attempt<_retries){await new Promise(r=>setTimeout(r,(attempt+1)*10000));continue;}
        if(!res.ok){const e=await res.json().catch(()=>({}));throw new Error(e.error?.message||'API error '+res.status);}
        data = await res.json();
        if(data.error) throw new Error(data.error.message||'OpenAI error');
        const reply = data.output_text || (data.output||[])
          .flatMap(item => item?.content || [])
          .filter(part => part?.type === 'output_text' || part?.type === 'text')
          .map(part => part?.text || '')
          .join('') || 'No response.';
        return finishAI(reply, { server: false, byok: true, usage: data.usage });
      }
    } catch(e){
      if(attempt < _retries && (e.message.includes('429')||e.message.includes('rate'))){
        await new Promise(r=>setTimeout(r,(attempt+1)*10000)); continue;
      }
      trackAIEvent('alex_response_error', {
        callType: analyticsType,
        provider,
        model,
        useWebSearch,
        durationMs: Date.now() - aiStartedAt,
        success: false,
        server: false,
        errorType: e.message?.includes('429') || e.message?.includes('rate') ? 'rate_limit' : 'api_error',
      });
      throw e;
    }
  }
  throw new Error('Rate limit — please wait and try again.');
}

// ── Grok News — disabled until xAI API is available ──────────
const _newsCache={};
async function callGrokNews(query, maxTok=300){ return null; }

// ── Expose on window.App AND window (for dhq-ai.js compatibility) ──
Object.assign(window.App, {
  AI_POLICY_VERSION,
  AI_MODELS,
  AI_TIER_MODELS,
  AI_ROUTES,
  DEFAULT_PROVIDER_BY_TIER,
  PROVIDERS,
  MODEL_ROUTING,
  routeForTier,
  routeForType,
  _newsCache,
  updateProviderHint,
  hasServerAI,
  hasAnyAI,
  callClaude,
  callGrokNews,
});

window.PROVIDERS = PROVIDERS;
window.AI_POLICY_VERSION = AI_POLICY_VERSION;
window.updateProviderHint = updateProviderHint;
window.hasServerAI = hasServerAI;
window.hasAnyAI = hasAnyAI;
window.callClaude = callClaude;
window.callGrokNews = callGrokNews;
window._newsCache = _newsCache;

})();
