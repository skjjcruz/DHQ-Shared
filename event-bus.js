// ══════════════════════════════════════════════════════════════════
// shared/event-bus.js — lightweight pub/sub event bus
// Replaces flag-polling (LI_LOADED) and direct cross-module function calls
// with decoupled event dispatch.
// Requires: shared/utils.js (dhqLog) loaded first.
//
// Known events:
//   'li:loaded'   — LeagueIntel finished loading (fresh or cache).
//                   payload: { source: 'fresh' | 'cache' }
// ══════════════════════════════════════════════════════════════════

window.App = window.App || {};

// dhqLog is guaranteed by storage.js (loads before event-bus.js).
const _evLog = (ctx, e, x) => window.dhqLog(ctx, e, x);

const _listeners = {};

const DhqEvents = {
  // Subscribe to an event. Returns an unsubscribe function.
  on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
    return () => DhqEvents.off(event, fn);
  },

  // Unsubscribe a specific handler from an event.
  off(event, fn) {
    _listeners[event] = (_listeners[event] || []).filter(f => f !== fn);
  },

  // Emit an event with an optional data payload to all subscribers.
  emit(event, data) {
    (_listeners[event] || []).forEach(fn => {
      try {
        fn(data);
      } catch (e) {
        _evLog('event-bus', e, { event });
      }
    });
  },

  // Subscribe to an event exactly once — auto-unsubscribes after first call.
  once(event, fn) {
    const unsub = DhqEvents.on(event, data => { unsub(); fn(data); });
    return unsub;
  },
};

window.App.DhqEvents = DhqEvents;
window.DhqEvents = DhqEvents;
