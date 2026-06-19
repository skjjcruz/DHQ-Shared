/*  alex-voice.js — shared voice helper for Alex's generated copy
 *
 *  Two jobs:
 *   1. Deterministic phrase variation, so two notes built from the same
 *      template branch never read identically. Seed off something stable
 *      (player id, position, pick slot) and the same row always renders the
 *      same wording across re-renders — but neighbours differ.
 *   2. Template-first AI upgrade. Surfaces render their (human-sounding)
 *      template immediately, then optionally call AlexVoice.enhance() to swap
 *      in real, personality-aware prose from dhqAI when AI is available.
 *      If AI is off or errors, the template stands — no loading states, no
 *      empty UI, no thrown errors.
 *
 *  Plain JS (no JSX/Babel). Exposes window.AlexVoice.
 */
(function () {
  'use strict';

  // FNV-1a-ish string hash → unsigned 32-bit int. Stable across reloads.
  function hashStr(str) {
    var s = String(str == null ? '' : str);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // Deterministically pick one entry of arr based on seed.
  function pick(seed, arr) {
    if (!arr || !arr.length) return '';
    return arr[hashStr(seed) % arr.length];
  }

  // Like pick, but rotated by `offset` (e.g. a row index). Two callers that
  // share a hash collision still land on different variants because the
  // offset steps them through the pool — kills "every row opens the same way".
  function pickRot(seed, arr, offset) {
    if (!arr || !arr.length) return '';
    return arr[(hashStr(seed) + (offset | 0)) % arr.length];
  }

  // Pick `n` DISTINCT entries (in seed-shuffled order). Falls back to fewer
  // if the pool is small. Useful when a single note wants two different
  // connectives that must not collide.
  function pickList(seed, arr, n) {
    if (!arr || !arr.length) return [];
    var idx = arr.map(function (_, i) { return i; });
    // Fisher-Yates seeded by successive hashes.
    var h = hashStr(seed);
    for (var i = idx.length - 1; i > 0; i--) {
      h = hashStr(h + ':' + i);
      var j = h % (i + 1);
      var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    var count = Math.min(n || 1, arr.length);
    var out = [];
    for (var k = 0; k < count; k++) out.push(arr[idx[k]]);
    return out;
  }

  function cap(s) {
    s = String(s || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  // Join a list into natural prose: ["a","b","c"] → "a, b and c".
  function joinNatural(arr, conj) {
    var a = (arr || []).filter(Boolean);
    if (!a.length) return '';
    if (a.length === 1) return a[0];
    if (a.length === 2) return a[0] + ' ' + (conj || 'and') + ' ' + a[1];
    return a.slice(0, -1).join(', ') + ', ' + (conj || 'and') + ' ' + a[a.length - 1];
  }

  // Strip model formatting so AI output drops cleanly into compact UI:
  // markdown bullets/emphasis, code fences, a trailing "— Alex" sign-off, and
  // collapsed whitespace.
  function sanitize(text) {
    var t = String(text || '');
    t = t.replace(/```[\s\S]*?```/g, ' ');         // code fences
    t = t.replace(/^[\s>*\-•\d.)]+/gm, '');         // leading bullets/quotes
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');        // bold
    t = t.replace(/\*([^*]+)\*/g, '$1');            // italics
    t = t.replace(/`([^`]+)`/g, '$1');              // inline code
    t = t.replace(/\s*[—-]\s*Alex\s*$/i, '');       // sign-off
    t = t.replace(/\s+/g, ' ').trim();
    return t;
  }

  function getAI() {
    return (typeof window.dhqAI === 'function') ? window.dhqAI : null;
  }

  // Is real AI reachable right now? (server session, BYO key, or dev preview)
  function hasAI() {
    try {
      if (!getAI()) return false;
      if (typeof window.hasAnyAI === 'function') return !!window.hasAnyAI(false);
      if (typeof window.hasServerAI === 'function') return !!window.hasServerAI();
      return !!(window.S && window.S.apiKey);
    } catch (e) { return false; }
  }

  var _cache = new Map();

  function getCached(key) {
    return key && _cache.has(key) ? _cache.get(key) : null;
  }

  /*  enhance — template-first AI upgrade.
   *  opts: {
   *    type:      DHQ_PROMPTS key (default 'strategy-analysis')
   *    message:   short user-style instruction for the model
   *    context:   JSON/string context block
   *    fallback:  the template text to return when AI is unavailable/fails
   *    cacheKey:  stable key; cached results skip the network entirely
   *    maxTok:    optional token cap (ignored by dhqAI's per-type default)
   *    transform: optional fn(rawText) → parsed value (e.g. split into a map);
   *               if it throws or returns falsy, fallback is used.
   *  }
   *  Returns a Promise resolving to the enhanced value (or fallback).
   *  Never rejects.
   */
  function enhance(opts) {
    opts = opts || {};
    var fallback = opts.fallback;
    var key = opts.cacheKey;
    if (key && _cache.has(key)) return Promise.resolve(_cache.get(key));
    if (!hasAI()) return Promise.resolve(fallback);
    var ai = getAI();
    return Promise.resolve()
      .then(function () {
        return ai(opts.type || 'strategy-analysis', opts.message || '', opts.context || '', opts.options);
      })
      .then(function (reply) {
        var raw = (typeof reply === 'string')
          ? reply
          : (reply && (reply.text || reply.response || reply.analysis)) || '';
        raw = sanitize(raw);
        if (!raw) return fallback;
        var value = raw;
        if (typeof opts.transform === 'function') {
          try {
            value = opts.transform(raw);
            if (!value) return fallback;
          } catch (e) { return fallback; }
        }
        if (key) _cache.set(key, value);
        return value;
      })
      .catch(function () { return fallback; });
  }

  window.AlexVoice = {
    hashStr: hashStr,
    pick: pick,
    pickRot: pickRot,
    pickList: pickList,
    cap: cap,
    joinNatural: joinNatural,
    sanitize: sanitize,
    hasAI: hasAI,
    enhance: enhance,
    getCached: getCached,
    _cache: _cache,
  };
})();
