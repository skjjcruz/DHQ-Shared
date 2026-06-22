// shared/bug-capture.js -- first-party Sentry browser error capture.
// Error monitoring only: no replay, no performance tracing, no user PII.

(function () {
  'use strict';

  if (window.DHQBugCapture?.installed) return;

  const App = window.App || (window.App = {});
  const config = App.CONFIG || window.OD?.CONFIG || {};
  const sentryConfig = config.sentry || {};
  const appName = inferAppName();
  const dsnValue = sentryConfig.dsn?.[appName] || sentryConfig.dsn || '';
  const dsn = typeof dsnValue === 'string' ? dsnValue : '';
  const enabled = sentryConfig.enabled !== false && !!dsn && !isLocal();
  const release = window.DYNASTY_HQ_RELEASE || sentryConfig.release || 'launch-2026-05-03';
  const environment = isLocal() ? 'development' : 'production';
  const sdkUrl = sentryConfig.sdkUrl || 'https://browser.sentry-cdn.com/8.55.0/bundle.min.js';
  const earlyEvents = [];
  const sensitiveKey = /(password|passwd|pwd|token|secret|authorization|apikey|api_key|apiKey|cookie|session|dsn|swid|espnS2|refresh_token|access_token|email)/i;
  let initialized = false;

  function inferAppName() {
    if (window.DYNASTY_HQ_APP) return String(window.DYNASTY_HQ_APP).toLowerCase();
    if (window.WRShared || /war\s*room/i.test(document.title || '')) return 'warroom';
    return 'reconai';
  }

  function isLocal() {
    const host = window.location.hostname || '';
    return ['localhost', '127.0.0.1', '0.0.0.0'].includes(host) || window.location.protocol === 'file:';
  }

  function scrubString(value) {
    return String(value)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [Filtered]')
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt]')
      .replace(/(sbp|sk|pk|rk)_[A-Za-z0-9_=-]{12,}/g, '[secret]');
  }

  function scrub(value, depth = 0) {
    if (value == null || depth > 5) return value;
    if (typeof value === 'string') return scrubString(value).slice(0, 2000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: scrubString(value.message || ''),
        stack: scrubString(value.stack || '').slice(0, 4000),
      };
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrub(item, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      Object.entries(value).slice(0, 80).forEach(([key, item]) => {
        out[key] = sensitiveKey.test(key) ? '[Filtered]' : scrub(item, depth + 1);
      });
      return out;
    }
    return String(value);
  }

  function safeRoute() {
    return (window.location.pathname || '/').replace(/[?#].*$/, '') || '/';
  }

  function userTier() {
    try {
      if (typeof window.getTier === 'function') return String(window.getTier() || 'unknown');
      if (typeof window.App?.getTier === 'function') return String(window.App.getTier() || 'unknown');
      const profile = JSON.parse(localStorage.getItem('od_profile_v1') || 'null');
      return String(profile?.tier || 'unknown');
    } catch {
      return 'unknown';
    }
  }

  function sanitizeEvent(event) {
    event.tags = {
      ...(event.tags || {}),
      app: appName,
      route: safeRoute(),
      user_tier: userTier(),
    };
    event.user = undefined;
    if (event.request) {
      event.request.url = `${window.location.origin}${safeRoute()}`;
      event.request.query_string = undefined;
      event.request.cookies = undefined;
      event.request.headers = undefined;
      event.request.data = scrub(event.request.data);
    }
    event.extra = scrub(event.extra || {});
    event.contexts = scrub(event.contexts || {});
    event.breadcrumbs = (event.breadcrumbs || []).slice(-30).map((crumb) => scrub(crumb));
    if (event.message) event.message = scrubString(event.message);
    if (event.exception?.values) {
      event.exception.values = event.exception.values.map((item) => ({
        ...item,
        value: item.value ? scrubString(item.value) : item.value,
      }));
    }
    return event;
  }

  function withScope(tags, extra, fn) {
    if (!window.Sentry?.withScope) return fn();
    return window.Sentry.withScope((scope) => {
      Object.entries(tags || {}).forEach(([key, value]) => scope.setTag(key, String(value)));
      if (extra !== undefined) scope.setExtra('details', scrub(extra));
      return fn(scope);
    });
  }

  function trackClientError(error, tags, eventId) {
    try {
      if (!window.OD?.trackClientError) return;
      window.OD.trackClientError({
        platform: appName,
        module: window.S?.activeTab || window.App?.activeTab || null,
        source: tags?.source || 'unknown',
        errorName: error?.name || 'Error',
        sentryEventId: eventId || null,
        handled: tags?.handled !== false,
      });
    } catch {}
  }

  function captureError(error, tags, extra) {
    if (!enabled) return;
    const err = error instanceof Error ? error : new Error(scrubString(error?.message || String(error || 'Unknown error')));
    if (!initialized || !window.Sentry?.captureException) {
      earlyEvents.push({ error: err, tags: tags || {}, extra: extra || null });
      if (earlyEvents.length > 20) earlyEvents.shift();
      return;
    }
    const eventId = withScope(tags, extra, () => window.Sentry.captureException(err));
    trackClientError(err, tags, eventId);
    return eventId;
  }

  function captureMessage(message, level, tags, extra) {
    if (!enabled || !initialized || !window.Sentry?.captureMessage) return;
    withScope(tags, extra, () => window.Sentry.captureMessage(scrubString(message), level || 'info'));
  }

  function initSentry() {
    if (initialized || !enabled || !window.Sentry?.init) return;
    window.Sentry.init({
      dsn,
      environment,
      release: `${appName}@${release}`,
      tracesSampleRate: 0,
      sampleRate: 1,
      sendDefaultPii: false,
      attachStacktrace: true,
      beforeSend: sanitizeEvent,
      ignoreErrors: [
        'ResizeObserver loop limit exceeded',
        'ResizeObserver loop completed with undelivered notifications',
        'Non-Error promise rejection captured',
      ],
    });
    initialized = true;
    window.Sentry.setTag?.('app', appName);
    window.Sentry.setTag?.('route', safeRoute());
    window.Sentry.setTag?.('user_tier', userTier());
    window.Sentry.setContext?.('runtime', {
      app: appName,
      route: safeRoute(),
      host: window.location.hostname || '',
    });
    while (earlyEvents.length) {
      const queued = earlyEvents.shift();
      captureError(queued.error, { ...queued.tags, source: queued.tags?.source || 'early_error' }, queued.extra);
    }
  }

  function loadSdk() {
    if (!enabled) return;
    if (window.Sentry?.init) {
      initSentry();
      return;
    }
    const script = document.createElement('script');
    script.src = sdkUrl;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = initSentry;
    script.onerror = () => {
      if (typeof console !== 'undefined') console.warn('[BugCapture] Sentry SDK failed to load');
    };
    document.head.appendChild(script);
  }

  window.addEventListener('error', (event) => {
    if (initialized) return;
    captureError(event.error || event.message, { source: 'window_error' }, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (initialized) return;
    captureError(event.reason, { source: 'unhandled_rejection' });
  });

  window.DHQBugCapture = {
    installed: true,
    app: appName,
    enabled,
    captureError,
    captureMessage,
    scrub,
  };

  loadSdk();
})();
