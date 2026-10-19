/* Live "what is running on this page" panel on the Cookie Policy page. */
(function () {
  'use strict';
  var root = document.getElementById('consent-status');
  if (!root) return;

  function set(key, text, on) {
    var el = root.querySelector('[data-status="' + key + '"]');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('on', on === true);
    el.classList.toggle('off', on === false);
  }

  function cookieNames() {
    return document.cookie ? document.cookie.split('; ').map(function (c) { return c.split('=')[0]; }) : [];
  }

  function render() {
    var cmp = window.ConsentManager;
    var consent = cmp && cmp.getConsent();
    var loaded = window.__bcbScripts || {};
    if (consent) {
      set('decision', 'Recorded ' + new Date(consent.recordedAt).toLocaleString());
      set('consent-id', consent.id);
      set('version', 'v' + consent.policyVersion);
      set('analytics', consent.preferences.analytics ? 'Allowed' : 'Not allowed', consent.preferences.analytics);
      set('marketing', consent.preferences.marketing ? 'Allowed' : 'Not allowed', consent.preferences.marketing);
    } else {
      set('decision', 'No decision yet (banner shown)');
      set('consent-id', '–');
      set('version', 'v' + (cmp ? cmp.policyVersion : '?'));
      set('analytics', 'Not allowed', false);
      set('marketing', 'Not allowed', false);
    }
    set('analytics-script', loaded.analytics ? 'Loaded and running' : 'Blocked (not executed)', !!loaded.analytics);
    set('marketing-script', loaded.marketing ? 'Loaded and running' : 'Blocked (not executed)', !!loaded.marketing);
    var names = cookieNames();
    set('cookies', names.length ? names.join(', ') : 'None');
  }

  document.addEventListener('bcb:consent-changed', render);
  document.addEventListener('bcb:script-loaded', render);
  window.addEventListener('load', render);
  setInterval(render, 2000);
  render();
})();
