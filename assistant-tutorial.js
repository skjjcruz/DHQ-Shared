// ============================================================================
// shared/assistant-tutorial.js
// Shared first-launch GM briefing tutorial engine for Scout and War Room.
// Product files provide config; this engine owns UI, state, analytics, and replay.
// ============================================================================

(function() {
  window.App = window.App || {};
  window.OD = window.OD || {};

  const STORAGE_KEY = 'dhq_assistant_tutorial_state_v1';
  const DEFAULT_VERSION = 'gm-brief-v1';
  const VALID_PRODUCTS = new Set(['scout', 'warroom']);

  let activeRun = null;
  let stylesInjected = false;

  function normalizeConfig(config) {
    const out = config || {};
    out.productKey = VALID_PRODUCTS.has(out.productKey) ? out.productKey : 'scout';
    out.version = out.version || DEFAULT_VERSION;
    out.steps = Array.isArray(out.steps) ? out.steps : [];
    out.legacyKeys = Array.isArray(out.legacyKeys) ? out.legacyKeys : [];
    out.accent = out.accent || '#D4AF37';
    out.title = out.title || 'Welcome to the war room';
    out.kicker = out.kicker || 'Alex Ingram / Your AI GM';
    out.intro = out.intro || 'I will get you oriented fast. The goal is simple: know where the decisions live, where the leverage is, and where to pull me in.';
    out.finishTitle = out.finishTitle || 'We are ready';
    out.finishText = out.finishText || 'That is the room. Start with the highest-signal move, and bring me in before you pull any trigger.';
    return out;
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function readLocalState() {
    const state = readJson(STORAGE_KEY, {});
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  }

  function writeLocalRecord(productKey, record) {
    const state = readLocalState();
    state[productKey] = record;
    writeJson(STORAGE_KEY, state);
  }

  function hasLegacyCompletion(config) {
    return config.legacyKeys.some(key => {
      try { return !!localStorage.getItem(key); } catch { return false; }
    });
  }

  function readLocalRecord(config) {
    const state = readLocalState();
    return state[config.productKey] || null;
  }

  function isCompleted(record, config) {
    return !!record && record.product === config.productKey && record.version === config.version && !!record.completedAt;
  }

  function sanitizeRecord(config, skipped) {
    return {
      product: config.productKey,
      version: config.version,
      completedAt: nowIso(),
      skipped: !!skipped,
    };
  }

  function track(eventName, config, detail) {
    try {
      window.OD?.track?.(eventName, {
        platform: config.productKey === 'warroom' ? 'warroom' : 'reconai',
        module: 'assistant_tutorial',
        entityType: 'tutorial',
        entityId: config.productKey,
        metadata: {
          product: config.productKey,
          version: config.version,
          ...detail,
        },
      });
    } catch {}
  }

  async function loadRemoteRecord(config) {
    if (!window.OD?.loadTutorialState) return null;
    try {
      const state = await window.OD.loadTutorialState(config.productKey);
      if (!state) return null;
      if (state.product) return state;
      return state[config.productKey] || null;
    } catch {
      return null;
    }
  }

  async function saveRemoteRecord(config, record) {
    if (!window.OD?.saveTutorialState) return false;
    try {
      return !!await window.OD.saveTutorialState(config.productKey, record);
    } catch {
      return false;
    }
  }

  async function shouldShow(configInput) {
    const config = normalizeConfig(configInput);
    if (hasLegacyCompletion(config)) return false;
    if (isCompleted(readLocalRecord(config), config)) return false;
    const remote = await loadRemoteRecord(config);
    if (isCompleted(remote, config)) {
      writeLocalRecord(config.productKey, remote);
      return false;
    }
    return true;
  }

  async function complete(configInput, reason) {
    const config = normalizeConfig(configInput);
    const skipped = reason === 'skipped' || reason === 'escape';
    const record = sanitizeRecord(config, skipped);
    writeLocalRecord(config.productKey, record);
    config.legacyKeys.forEach(key => {
      try { localStorage.setItem(key, '1'); } catch {}
    });
    await saveRemoteRecord(config, record);
    track(skipped ? 'tutorial_skipped' : 'tutorial_completed', config, { reason: reason || 'completed' });
    window.dispatchEvent(new CustomEvent('dhq:tutorial-complete', {
      detail: { product: config.productKey, version: config.version, reason: reason || 'completed' },
    }));
    return record;
  }

  function reset(productKey) {
    const state = readLocalState();
    if (productKey) delete state[productKey];
    else Object.keys(state).forEach(key => delete state[key]);
    writeJson(STORAGE_KEY, state);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function injectStyles() {
    if (stylesInjected || document.getElementById('dhq-assistant-tutorial-styles')) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.id = 'dhq-assistant-tutorial-styles';
    style.textContent = `
      .dhq-tutorial-root{position:fixed;inset:0;z-index:100000;pointer-events:none;color:var(--text,#fff);font-family:inherit;overflow:hidden;max-width:100vw}
      .dhq-tutorial-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.72);backdrop-filter:blur(5px);pointer-events:auto}
      .dhq-tutorial-spotlight{position:fixed;border:2px solid var(--dhq-tutorial-accent,#D4AF37);border-radius:12px;box-shadow:0 0 0 2px rgba(212,175,55,.18),0 0 42px rgba(212,175,55,.28);pointer-events:none;transition:all .22s ease}
      .dhq-tutorial-panel{position:fixed;pointer-events:auto;box-sizing:border-box;width:calc(100vw - 32px);max-width:820px;max-height:calc(100vh - 32px);overflow:hidden;background:linear-gradient(135deg,rgba(9,9,9,.98),rgba(24,24,24,.98));border:1px solid rgba(212,175,55,.46);border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.72),inset 0 1px 0 rgba(255,255,255,.07);display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,240px);gap:16px;padding:18px}
      .dhq-tutorial-panel.is-center{left:50%;top:50%;transform:translate(-50%,-50%)}
      .dhq-tutorial-panel.is-anchored{width:calc(100vw - 32px);max-width:660px;grid-template-columns:minmax(0,1fr)}
      .dhq-tutorial-main{min-width:0}
      .dhq-tutorial-alex{display:flex;align-items:center;gap:10px;margin-bottom:13px}
      .dhq-tutorial-alex-face{width:40px;height:40px;border-radius:9px;flex-shrink:0;object-fit:cover;border:2px solid var(--dhq-tutorial-accent,#D4AF37);background:linear-gradient(135deg,#d4af37,#b8941e);display:flex;align-items:center;justify-content:center;font-weight:900;color:#0a0a0a;font-size:13px;letter-spacing:.02em}
      .dhq-tutorial-alex-id{display:flex;flex-direction:column;line-height:1.1}
      .dhq-tutorial-alex-id b{color:var(--dhq-tutorial-accent,#D4AF37);font-size:14px;font-weight:900;letter-spacing:.02em}
      .dhq-tutorial-alex-id small{color:rgba(255,255,255,.5);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;margin-top:2px}
      .dhq-tutorial-choices{display:flex;flex-direction:column;gap:8px;margin:12px 0 6px}
      .dhq-tutorial-choice{display:block;width:100%;text-align:left;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.035);border-radius:9px;padding:11px 13px;color:rgba(255,255,255,.82);font:inherit;cursor:pointer;transition:border-color .15s,background .15s}
      .dhq-tutorial-choice:hover{border-color:rgba(212,175,55,.45)}
      .dhq-tutorial-choice.is-active{border-color:var(--dhq-tutorial-accent,#D4AF37);background:rgba(212,175,55,.1)}
      .dhq-tutorial-choice b{display:block;color:#fff;font-size:14px;font-weight:850;margin-bottom:2px}
      .dhq-tutorial-choice.is-active b{color:var(--dhq-tutorial-accent,#D4AF37)}
      .dhq-tutorial-choice span{display:block;color:rgba(255,255,255,.58);font-size:12px;line-height:1.35}
      .dhq-tutorial-kicker{color:var(--dhq-tutorial-accent,#D4AF37);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.11em;margin-bottom:7px}
      .dhq-tutorial-title{font-size:clamp(22px,3.2vw,32px);line-height:1.02;font-weight:900;color:#fff;letter-spacing:0;margin:0 0 8px}
      .dhq-tutorial-copy{font-size:14px;line-height:1.48;color:rgba(255,255,255,.76);margin:0 0 12px;max-width:58ch}
      .dhq-tutorial-meta{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 13px}
      .dhq-tutorial-chip{border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.045);border-radius:7px;padding:6px 8px;color:rgba(255,255,255,.72);font-size:12px;font-weight:750}
      .dhq-tutorial-board{border:1px solid rgba(212,175,55,.18);background:rgba(212,175,55,.055);border-radius:9px;padding:12px;align-self:stretch;min-width:0}
      .dhq-tutorial-board span{display:block;color:var(--dhq-tutorial-accent,#D4AF37);font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.1em;margin-bottom:7px}
      .dhq-tutorial-board strong{display:block;color:#fff;font-size:17px;line-height:1.1;margin-bottom:8px}
      .dhq-tutorial-board p{margin:0;color:rgba(255,255,255,.66);font-size:12px;line-height:1.45}
      .dhq-tutorial-progress{display:flex;align-items:center;gap:8px;margin-top:12px}
      .dhq-tutorial-rail{height:5px;flex:1;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden}
      .dhq-tutorial-fill{height:100%;border-radius:99px;background:var(--dhq-tutorial-accent,#D4AF37);width:0;transition:width .22s ease}
      .dhq-tutorial-count{font-size:11px;color:rgba(255,255,255,.56);font-weight:800;white-space:nowrap}
      .dhq-tutorial-actions{display:flex;align-items:center;gap:8px;margin-top:14px}
      .dhq-tutorial-btn{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:rgba(255,255,255,.78);border-radius:7px;padding:9px 12px;font:inherit;font-size:13px;font-weight:850;cursor:pointer;min-height:38px}
      .dhq-tutorial-btn:hover{border-color:rgba(212,175,55,.4);color:#fff}
      .dhq-tutorial-btn:disabled{opacity:.4;cursor:not-allowed}
      .dhq-tutorial-btn.is-primary{background:var(--dhq-tutorial-accent,#D4AF37);border-color:var(--dhq-tutorial-accent,#D4AF37);color:#080808;flex:1}
      @media(max-width:720px){
        .dhq-tutorial-backdrop{backdrop-filter:blur(3px)}
        .dhq-tutorial-panel,.dhq-tutorial-panel.is-anchored{left:12px!important;right:12px!important;bottom:12px!important;top:auto!important;transform:none!important;width:auto;grid-template-columns:1fr;padding:15px;max-height:calc(100vh - 24px)}
        .dhq-tutorial-board{display:none}
        .dhq-tutorial-title{font-size:22px}
        .dhq-tutorial-copy{font-size:13px}
        .dhq-tutorial-actions{gap:7px}
        .dhq-tutorial-btn{padding:8px 10px;font-size:12px}
      }
      @media(prefers-reduced-motion:reduce){
        .dhq-tutorial-spotlight,.dhq-tutorial-fill{transition:none}
      }
    `;
    document.head.appendChild(style);
  }

  // 2026-07-08 single-voice ruling: the onboarding "Alex communication style"
  // picker is gone — one canonical Alex voice for everyone. The `alexPicker`
  // config flag both apps' tutorial configs may still pass is tolerated and
  // ignored (renders nothing).

  function alexHeaderHtml(config) {
    if (config.alexAvatar === false) return '';
    let faceInner = 'AI';
    try {
      const id = localStorage.getItem('wr_alex_avatar') || 'badge';
      const av = (window.ALEX_AVATARS || []).find(a => a.id === id);
      if (av && av.src) faceInner = `<img src="${escapeHtml(av.src)}" alt="Alex" style="width:100%;height:100%;object-fit:cover;border-radius:7px">`;
    } catch {}
    return `
      <div class="dhq-tutorial-alex">
        <span class="dhq-tutorial-alex-face">${faceInner}</span>
        <span class="dhq-tutorial-alex-id"><b>Alex Ingram</b><small>AI General Manager</small></span>
      </div>
    `;
  }

  function renderChoices(step) {
    if (!Array.isArray(step.choices) || !step.choices.length) return '';
    let current = '';
    try { current = (step.choiceKey && localStorage.getItem(step.choiceKey)) || ''; } catch {}
    return `
      <div class="dhq-tutorial-choices" aria-label="${escapeHtml(step.choicePrompt || 'Choose one')}">
        ${step.choices.map(c => `
          <button class="dhq-tutorial-choice${c.value === current ? ' is-active' : ''}" type="button" data-tutorial-choice="${escapeHtml(c.value)}">
            <b>${escapeHtml(c.label)}</b>${c.desc ? `<span>${escapeHtml(c.desc)}</span>` : ''}
          </button>
        `).join('')}
      </div>
    `;
  }

  function stepList(config) {
    return [
      {
        key: 'opening',
        title: config.title,
        desc: config.intro,
        kicker: config.kicker,
        position: 'center',
        chips: config.openingChips || ['90-second brief', 'GM room map', 'Replay anytime'],
        board: config.openingBoard || {
          label: 'Opening Brief',
          title: 'Front office orientation',
          body: 'I will show you where decisions happen, where leverage shows up, and where to pull me in.',
        },
      },
      ...config.steps,
      {
        key: 'finish',
        title: config.finishTitle,
        desc: config.finishText,
        kicker: 'Ready for kickoff',
        position: 'center',
        chips: config.finishChips || ['Command center ready', 'Alex on call', 'Settings has replay'],
        board: config.finishBoard || {
          label: 'Next Move',
          title: 'Open the board',
          body: 'Start with the highest-signal module, then ask Alex to pressure-test the move before you act.',
        },
      },
    ];
  }

  function clearRoot() {
    const old = document.getElementById('dhq-assistant-tutorial');
    if (old) old.remove();
  }

  function callStepOpen(step) {
    if (!step) return;
    try {
      if (typeof step.open === 'function') {
        step.open();
        return;
      }
      if (step.tabToOpen) {
        const selector = step.tabSelector || `[data-tab="${step.tabToOpen}"]`;
        const btn = document.querySelector(selector);
        if (btn) btn.click();
      }
      if (step.mobileTab && typeof window.mobileTab === 'function') window.mobileTab(step.mobileTab);
      else if (step.switchTab && typeof window.switchTab === 'function') window.switchTab(step.switchTab);
    } catch {}
  }

  function targetFor(step) {
    if (!step?.target) return null;
    try { return document.querySelector(step.target); } catch { return null; }
  }

  function panelPosition(step, target) {
    if (!target || step.position === 'center') return { center: true };
    const rect = target.getBoundingClientRect();
    const margin = 16;
    const panelW = Math.min(window.innerWidth * 0.92, 660);
    const panelH = 330;
    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;
    let left;
    let top = Math.max(margin, Math.min(rect.top, window.innerHeight - panelH - margin));
    if (spaceRight >= panelW + margin) left = rect.right + margin;
    else if (spaceLeft >= panelW + margin) left = rect.left - panelW - margin;
    else {
      left = Math.max(margin, Math.min(window.innerWidth - panelW - margin, rect.left));
      top = Math.min(window.innerHeight - panelH - margin, rect.bottom + margin);
    }
    return { left, top };
  }

  function renderRun() {
    if (!activeRun) return;
    const { config, steps } = activeRun;
    const step = steps[activeRun.index];
    callStepOpen(step);

    window.setTimeout(() => {
      if (!activeRun) return;
      const currentStep = steps[activeRun.index];
      const target = targetFor(currentStep);
      if (target && currentStep.scroll !== false) {
        try { target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); } catch {}
      }

      window.setTimeout(() => {
        if (!activeRun) return;
        drawStep(currentStep, targetFor(currentStep));
      }, currentStep.renderDelay || 140);
    }, step.openDelay || 0);
  }

  function drawStep(step, target) {
    const { config, steps, index } = activeRun;
    clearRoot();
    injectStyles();
    const root = document.createElement('div');
    root.id = 'dhq-assistant-tutorial';
    root.className = 'dhq-tutorial-root';
    root.style.setProperty('--dhq-tutorial-accent', config.accent);
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', step.title || config.title);

    const progress = Math.round(((index + 1) / steps.length) * 100);
    const pos = panelPosition(step, target);
    const centered = pos.center;
    const board = step.board || null;
    const chips = Array.isArray(step.chips) ? step.chips : [];

    root.innerHTML = `
      <div class="dhq-tutorial-backdrop"></div>
      ${target ? spotlightHtml(target) : ''}
      <section class="dhq-tutorial-panel ${centered ? 'is-center' : 'is-anchored'}" style="${centered ? '' : `left:${Math.round(pos.left)}px;top:${Math.round(pos.top)}px`}">
        <div class="dhq-tutorial-main">
          ${alexHeaderHtml(config)}
          <div class="dhq-tutorial-kicker">${escapeHtml(step.kicker || `Step ${index + 1} of ${steps.length}`)}</div>
          <h2 class="dhq-tutorial-title">${escapeHtml(step.title)}</h2>
          <p class="dhq-tutorial-copy">${escapeHtml(step.desc)}</p>
          ${chips.length ? `<div class="dhq-tutorial-meta">${chips.map(chip => `<span class="dhq-tutorial-chip">${escapeHtml(chip)}</span>`).join('')}</div>` : ''}
          ${renderChoices(step)}
          <div class="dhq-tutorial-progress">
            <div class="dhq-tutorial-rail"><div class="dhq-tutorial-fill" style="width:${progress}%"></div></div>
            <div class="dhq-tutorial-count">${index + 1}/${steps.length}</div>
          </div>
          <div class="dhq-tutorial-actions">
            <button class="dhq-tutorial-btn" type="button" data-tutorial-action="back" ${index === 0 ? 'disabled' : ''}>Back</button>
            <button class="dhq-tutorial-btn" type="button" data-tutorial-action="skip">Skip</button>
            <button class="dhq-tutorial-btn is-primary" type="button" data-tutorial-action="next">${index === steps.length - 1 ? 'Finish Briefing' : 'Next'}</button>
          </div>
        </div>
        ${board ? `
          <aside class="dhq-tutorial-board">
            <span>${escapeHtml(board.label || 'GM Note')}</span>
            <strong>${escapeHtml(board.title || '')}</strong>
            <p>${escapeHtml(board.body || '')}</p>
          </aside>
        ` : ''}
      </section>
    `;

    document.body.appendChild(root);
    bindRoot(root);
    if (!activeRun.seen.has(index)) {
      activeRun.seen.add(index);
      track('tutorial_step_viewed', config, {
        stepIndex: index + 1,
        stepKey: step.key || null,
        targetFound: !!target,
      });
    }
    focusPrimary(root);
  }

  function spotlightHtml(target) {
    const rect = target.getBoundingClientRect();
    const pad = 6;
    return `<div class="dhq-tutorial-spotlight" style="left:${Math.max(4, Math.round(rect.left - pad))}px;top:${Math.max(4, Math.round(rect.top - pad))}px;width:${Math.round(rect.width + pad * 2)}px;height:${Math.round(rect.height + pad * 2)}px"></div>`;
  }

  function bindRoot(root) {
    root.addEventListener('click', evt => {
      const action = evt.target?.closest?.('[data-tutorial-action]')?.dataset?.tutorialAction;
      if (action === 'next') next();
      if (action === 'back') back();
      if (action === 'skip') close('skipped');
      const choiceBtn = evt.target?.closest?.('[data-tutorial-choice]');
      if (choiceBtn) {
        const value = choiceBtn.dataset.tutorialChoice;
        const step = activeRun?.steps?.[activeRun.index];
        if (step?.choiceKey) { try { localStorage.setItem(step.choiceKey, value); } catch {} }
        root.querySelectorAll('.dhq-tutorial-choice').forEach(btn => btn.classList.toggle('is-active', btn.dataset.tutorialChoice === value));
        try {
          window.dispatchEvent(new CustomEvent('dhq:tutorial-choice', {
            detail: { key: step?.choiceKey || null, group: step?.choiceGroup || null, value },
          }));
        } catch {}
      }
    });
  }

  function focusPrimary(root) {
    window.setTimeout(() => {
      const btn = root.querySelector('[data-tutorial-action="next"]');
      try { btn?.focus?.({ preventScroll: true }); } catch {}
    }, 0);
  }

  function next() {
    if (!activeRun) return;
    if (activeRun.index >= activeRun.steps.length - 1) {
      close('completed');
      return;
    }
    activeRun.index += 1;
    renderRun();
  }

  function back() {
    if (!activeRun || activeRun.index <= 0) return;
    activeRun.index -= 1;
    renderRun();
  }

  async function close(reason) {
    if (!activeRun) return;
    const config = activeRun.config;
    clearRoot();
    activeRun = null;
    window.removeEventListener('keydown', keyHandler, true);
    await complete(config, reason);
  }

  function keyHandler(evt) {
    if (!activeRun) return;
    if (evt.key === 'Escape') {
      evt.preventDefault();
      close('escape');
    } else if (evt.key === 'ArrowRight' || evt.key === 'Enter') {
      evt.preventDefault();
      next();
    } else if (evt.key === 'ArrowLeft') {
      evt.preventDefault();
      back();
    }
  }

  async function start(configInput, options) {
    const config = normalizeConfig(configInput);
    const opts = options || {};
    if (activeRun) {
      clearRoot();
      window.removeEventListener('keydown', keyHandler, true);
      activeRun = null;
    }
    if (!opts.force && !await shouldShow(config)) return false;

    const steps = stepList(config);
    activeRun = { config, steps, index: 0, seen: new Set(), forced: !!opts.force };
    window.addEventListener('keydown', keyHandler, true);
    track(opts.force ? 'tutorial_replayed' : 'tutorial_started', config, { forced: !!opts.force });
    if (opts.force) track('tutorial_started', config, { forced: true });
    renderRun();
    return true;
  }

  window.App.AssistantTutorial = {
    start,
    shouldShow,
    complete,
    reset,
    isActive: () => !!activeRun,
    _readLocalState: readLocalState,
  };
})();
