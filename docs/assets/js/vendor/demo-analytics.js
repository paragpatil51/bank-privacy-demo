/*
 * SIMULATED third-party analytics script ("Demo Analytics").
 * It only ever runs if the consent manager activates it after analytics consent.
 * It sets analytics cookies and sends a page-view to the backend, which
 * independently re-checks the recorded consent before storing anything.
 */
(function () {
  'use strict';
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, maxAge) {
    document.cookie = name + '=' + encodeURIComponent(value) + '; Max-Age=' + maxAge + '; Path=/; SameSite=Lax';
  }
  function rid() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  if (!getCookie('_bcb_an_id')) setCookie('_bcb_an_id', 'AN.' + rid(), 365 * 86400);
  setCookie('_bcb_an_session', getCookie('_bcb_an_session') || 'S.' + rid(), 30 * 60);

  fetch('/api/telemetry/analytics', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'page_view', path: location.pathname }),
  }).catch(function () { /* analytics must never break the page */ });

  window.__bcbScripts = window.__bcbScripts || {};
  window.__bcbScripts.analytics = true;
  console.info('[Demo Analytics] loaded after consent: page view sent for', location.pathname);
  document.dispatchEvent(new CustomEvent('bcb:script-loaded', { detail: { category: 'analytics' } }));
})();
