/*
 * SIMULATED third-party marketing pixel ("Demo Ads Network").
 * Runs only after marketing consent has been given and recorded.
 */
(function () {
  'use strict';
  if (!/(?:^|; )_bcb_mkt_id=/.test(document.cookie)) {
    var id = 'MK.' + Math.random().toString(36).slice(2, 12);
    document.cookie = '_bcb_mkt_id=' + id + '; Max-Age=' + 90 * 86400 + '; Path=/; SameSite=Lax';
  }

  fetch('/api/telemetry/marketing', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'page_view', path: location.pathname }),
  }).catch(function () { /* ignore */ });

  window.__bcbScripts = window.__bcbScripts || {};
  window.__bcbScripts.marketing = true;
  console.info('[Demo Ads Network] marketing pixel loaded after consent');
  document.dispatchEvent(new CustomEvent('bcb:script-loaded', { detail: { category: 'marketing' } }));
})();
