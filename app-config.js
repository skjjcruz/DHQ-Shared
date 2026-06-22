// shared/app-config.js -- canonical browser runtime config.
// Public values only. Secrets stay in Supabase Edge Function settings.

(function () {
  'use strict';

  window.App = window.App || {};
  window.OD = window.OD || {};

  const existing = window.DYNASTY_HQ_CONFIG || window.App.CONFIG || window.OD.CONFIG || {};

  const supabaseUrl = existing.supabaseUrl || 'https://sxshiqyxhhifvtfqawbq.supabase.co';
  const supabaseAnon = existing.supabaseAnon
    || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4c2hpcXl4aGhpZnZ0ZnFhd2JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3MTExMzAsImV4cCI6MjA4ODI4NzEzMH0.zJi9W986ZLaANiZN6pt6ReFwaQU6yPeidsERIWo2ibI';
  const functionsBase = existing.functionsBase || `${supabaseUrl}/functions/v1`;
  const reconAiBase = existing.reconAiBase || 'https://c2-football.github.io/ReconAI/';
  const reconAiSharedBase = existing.reconAiSharedBase || `${reconAiBase}shared/`;
  const defaultSentry = {
    enabled: true,
    sdkUrl: 'https://browser.sentry-cdn.com/8.55.0/bundle.min.js',
    release: 'launch-2026-05-03',
    dsn: {
      reconai: 'https://60c6987e08918ef1306b1582a86b1941@o4511323490222080.ingest.us.sentry.io/4511323533869056',
      warroom: 'https://fbe10be66ec013dc267fb092dcf16fff@o4511323490222080.ingest.us.sentry.io/4511323529674752',
    },
  };

  const defaultEndpoints = {
    aiAnalyze: `${functionsBase}/ai-analyze`,
    getSessionToken: `${functionsBase}/get-session-token`,
    setPassword: `${functionsBase}/set-password`,
    espnProxy: `${functionsBase}/espn-proxy`,
    mflProxy: `${functionsBase}/mfl-proxy`,
    yahooProxy: `${functionsBase}/yahoo-proxy`,
    adminListUsers: `${functionsBase}/admin-list-users`,
    fwSignup: `${functionsBase}/fw-signup`,
    fwSignin: `${functionsBase}/fw-signin`,
    fwProfile: `${functionsBase}/fw-profile`,
    fwCreateCheckout: `${functionsBase}/fw-create-checkout`,
    fwStripeWebhook: `${functionsBase}/fw-stripe-webhook`,
  };

  const config = {
    ...existing,
    supabaseUrl,
    supabaseAnon,
    functionsBase,
    reconAiBase,
    reconAiSharedBase,
    sentry: {
      ...defaultSentry,
      ...(existing.sentry || {}),
      dsn: {
        ...defaultSentry.dsn,
        ...(existing.sentry?.dsn || {}),
      },
    },
    endpoints: {
      ...defaultEndpoints,
      ...(existing.endpoints || {}),
    },
  };

  window.App.CONFIG = config;
  window.OD.CONFIG = config;
  window.App.getConfig = function () { return window.App.CONFIG; };
  window.OD.getConfig = function () { return window.OD.CONFIG; };
})();
