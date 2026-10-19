/*
 * Consent Management Platform (CMP) – browser SDK (demo).
 *
 * How optional scripts are blocked:
 *   Optional scripts are written into the page as
 *     <script type="text/plain" data-cmp-category="analytics" data-cmp-src="...">
 *   Browsers never execute type="text/plain", so nothing runs on page load.
 *   This SDK creates a real <script> only for categories the visitor has
 *   consented to AND whose consent has been recorded by the backend.
 *
 * Withdrawal: when a category is switched off, its cookies are deleted and the
 * page reloads, because code that has already run cannot be "unloaded".
 */
(function () {
  'use strict';

  var cfgEl = document.getElementById('cmp-config');
  if (!cfgEl) return;
  var cfg = JSON.parse(cfgEl.textContent);
  var OPTIONAL = cfg.categories.filter(function (c) { return !c.required; }).map(function (c) { return c.id; });

  var banner = document.getElementById('cmp-banner');
  var overlay = document.getElementById('cmp-overlay');
  var fab = document.getElementById('cmp-fab');
  var toastEl = document.getElementById('cmp-toast');
  var categoriesEl = document.getElementById('cmp-categories');
  var currentEl = document.getElementById('cmp-current');

  var state = null;            // active consent for the current policy version
  var knownVisitorId = null;   // kept across policy versions so history stays linked
  var activated = {};
  var listeners = [];
  var lastFocus = null;
  var busy = false;

  // ------------------------------------------------------------ storage
  function readCookie(name) {
    var parts = document.cookie ? document.cookie.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var idx = parts[i].indexOf('=');
      if (parts[i].slice(0, idx) === name) {
        try { return decodeURIComponent(parts[i].slice(idx + 1)); } catch (e) { return null; }
      }
    }
    return null;
  }

  function loadStored() {
    var raw = readCookie(cfg.cookieName);
    if (!raw) return null;
    var c;
    try { c = JSON.parse(raw); } catch (e) { return null; }
    if (!c || typeof c.vid !== 'string') return null;
    knownVisitorId = c.vid;
    if (c.v !== cfg.policyVersion) return null; // policy changed: ask again
    var ts = Date.parse(c.ts);
    if (!ts || Date.now() - ts > cfg.maxAgeDays * 864e5) return null; // consent expired
    return {
      id: c.id,
      visitorId: c.vid,
      policyVersion: c.v,
      recordedAt: c.ts,
      preferences: { necessary: true, analytics: c.a === 1, marketing: c.m === 1 },
      pending: c.p || null,
    };
  }

  function writeStored(s) {
    var value = JSON.stringify({
      v: s.policyVersion, id: s.id, vid: s.visitorId,
      a: s.preferences.analytics ? 1 : 0, m: s.preferences.marketing ? 1 : 0,
      ts: s.recordedAt, p: s.pending || undefined,
    });
    document.cookie = cfg.cookieName + '=' + encodeURIComponent(value) +
      '; Max-Age=' + cfg.maxAgeDays * 86400 + '; Path=/; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
  }

  function deleteCategoryCookies(categoryId) {
    var cat = cfg.categories.filter(function (c) { return c.id === categoryId; })[0];
    if (!cat) return;
    var host = location.hostname;
    var domains = ['', host, '.' + host];
    var parts = host.split('.');
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    cat.cookies.forEach(function (ck) {
      domains.forEach(function (d) {
        document.cookie = ck.name + '=; Max-Age=0; Path=/' + (d ? '; Domain=' + d : '');
      });
    });
  }

  // --------------------------------------------------- script activation
  // Only same-origin scripts in /assets/js/vendor/ may ever be activated, even
  // if someone manages to inject a blocked <script> tag into the page. With
  // Trusted Types enforced by the CSP, this policy is the only way any script
  // URL can be created at all.
  function vetScriptUrl(raw) {
    var u = new URL(raw, location.href);
    if (u.origin !== location.origin || !/\/assets\/js\/vendor\/[a-z0-9-]+\.js$/.test(u.pathname) || u.search || u.hash) {
      throw new TypeError('Consent manager blocked an unapproved script URL: ' + raw);
    }
    return u.href;
  }
  var scriptPolicy = null;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try { scriptPolicy = window.trustedTypes.createPolicy('bcb-cmp', { createScriptURL: vetScriptUrl }); } catch (e) { scriptPolicy = null; }
  }

  function activateScripts(prefs) {
    var blocked = document.querySelectorAll('script[type="text/plain"][data-cmp-category]');
    Array.prototype.forEach.call(blocked, function (el) {
      var category = el.getAttribute('data-cmp-category');
      if (!prefs[category] || el.hasAttribute('data-cmp-activated')) return;
      el.setAttribute('data-cmp-activated', '');
      var src;
      try {
        src = scriptPolicy ? scriptPolicy.createScriptURL(el.getAttribute('data-cmp-src')) : vetScriptUrl(el.getAttribute('data-cmp-src'));
      } catch (err) {
        console.error(err.message);
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-cmp-loaded-category', category);
      el.parentNode.insertBefore(s, el.nextSibling);
      activated[category] = true;
    });
  }

  function applyTransition(prev, next) {
    var revoked = OPTIONAL.filter(function (c) { return prev && prev.preferences[c] && !next.preferences[c]; });
    revoked.forEach(deleteCategoryCookies);
    if (revoked.some(function (c) { return activated[c]; })) {
      toast('Preferences saved. Reloading the page to stop scripts you switched off…');
      setTimeout(function () { location.reload(); }, 900);
      return;
    }
    activateScripts(next.preferences);
  }

  function notify() {
    var snapshot = getConsent();
    listeners.forEach(function (fn) { try { fn(snapshot); } catch (e) { /* ignore listener errors */ } });
    document.dispatchEvent(new CustomEvent('bcb:consent-changed', { detail: snapshot }));
  }

  // ------------------------------------------------------------------ UI
  function toast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { toastEl.hidden = true; }, 4000);
  }

  function setError(message) {
    document.querySelectorAll('[data-cmp-error]').forEach(function (el) {
      el.textContent = message || '';
      el.hidden = !message;
    });
  }

  function setBusy(value) {
    busy = value;
    document.querySelectorAll('[data-cmp-action]').forEach(function (b) {
      b.disabled = value;
      b.setAttribute('aria-busy', value ? 'true' : 'false');
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function renderCategories() {
    categoriesEl.textContent = '';
    cfg.categories.forEach(function (cat) {
      var control;
      if (cat.required) {
        control = el('span', { class: 'cmp-always', text: 'Always active' });
      } else {
        var input = el('input', { type: 'checkbox', role: 'switch', id: 'cmp-toggle-' + cat.id, 'data-cmp-toggle': cat.id, 'aria-describedby': 'cmp-desc-' + cat.id });
        input.checked = !!(state && state.preferences[cat.id]);
        var stateLabel = el('span', { class: 'switch-label', 'aria-hidden': 'true', text: input.checked ? 'On' : 'Off' });
        input.addEventListener('change', function () { stateLabel.textContent = input.checked ? 'On' : 'Off'; });
        control = el('label', { class: 'switch', for: 'cmp-toggle-' + cat.id }, [
          input, el('span', { class: 'track' }), stateLabel,
          el('span', { class: 'visually-hidden', text: cat.title + ' cookies' }),
        ]);
      }
      var cookieList = el('ul', {}, cat.cookies.map(function (ck) {
        return el('li', { text: ck.name + ' – ' + ck.purpose + ' (' + ck.provider + ', ' + ck.duration + ')' });
      }));
      categoriesEl.appendChild(el('div', { class: 'cmp-category' }, [
        el('header', {}, [el('h3', { text: cat.title }), control]),
        el('p', { id: 'cmp-desc-' + cat.id, text: cat.description }),
        el('details', {}, [el('summary', { text: 'Cookies in this category (' + cat.cookies.length + ')' }), cookieList]),
      ]));
    });
    if (state) {
      currentEl.textContent = 'Current choice recorded ' + new Date(state.recordedAt).toLocaleString() +
        ' · Consent ID ' + state.id.slice(0, 8) + '… · Policy v' + state.policyVersion;
    } else {
      currentEl.textContent = 'No choice recorded yet. Optional cookies are off.';
    }
  }

  function focusables() {
    return Array.prototype.filter.call(
      overlay.querySelectorAll('button, [href], input, summary, [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; }
    );
  }

  function openModal() {
    lastFocus = document.activeElement;
    setError('');
    renderCategories();
    overlay.hidden = false;
    document.body.classList.add('cmp-modal-open');
    var first = overlay.querySelector('[data-cmp-toggle]') || overlay.querySelector('[data-cmp-close]');
    first.focus();
  }

  function closeModal() {
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.classList.remove('cmp-modal-open');
    if (lastFocus && document.contains(lastFocus) && lastFocus.offsetParent !== null) lastFocus.focus();
  }

  function showBanner() { banner.hidden = false; fab.hidden = true; }
  function hideBanner() { banner.hidden = true; fab.hidden = false; }

  // ------------------------------------------------------------ actions
  function preferencesFor(action) {
    var prefs = { necessary: true };
    OPTIONAL.forEach(function (c) {
      if (action === 'accept_all') prefs[c] = true;
      else if (action === 'reject_optional') prefs[c] = false;
      else {
        var t = overlay.querySelector('[data-cmp-toggle="' + c + '"]');
        prefs[c] = !!(t && t.checked);
      }
    });
    return prefs;
  }

  function postConsent(action, prefs) {
    return fetch(cfg.endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitorId: (state && state.visitorId) || knownVisitorId || null,
        preferences: prefs,
        action: action,
        policyVersion: cfg.policyVersion,
      }),
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        if (!res.ok) {
          var err = new Error((body && body.error && body.error.message) || 'The server returned ' + res.status);
          err.code = body && body.error && body.error.code;
          throw err;
        }
        return body.consent;
      });
    });
  }

  function save(action, prefsOverride, silent) {
    if (busy) return Promise.resolve();
    var prefs = prefsOverride || preferencesFor(action);
    setBusy(true);
    setError('');
    return postConsent(action, prefs).then(function (consent) {
      var prev = state;
      state = {
        id: consent.id,
        visitorId: consent.visitorId,
        policyVersion: consent.policyVersion,
        recordedAt: consent.recordedAt,
        preferences: consent.preferences,
        pending: null,
      };
      knownVisitorId = consent.visitorId;
      writeStored(state);
      hideBanner();
      closeModal();
      notify();
      if (!silent) toast('Your cookie preferences have been saved.');
      applyTransition(prev, state);
    }).catch(function (err) {
      if (err.code === 'POLICY_VERSION_MISMATCH') { location.reload(); return; }
      // Granting needs a recorded consent; withdrawing must never depend on the server.
      if (state && OPTIONAL.some(function (c) { return state.preferences[c] && !prefs[c]; })) {
        var prev = state;
        var restricted = { necessary: true };
        OPTIONAL.forEach(function (c) { restricted[c] = !!(prev.preferences[c] && prefs[c]); });
        state = Object.assign({}, prev, { preferences: restricted, pending: { action: action, analytics: !!prefs.analytics, marketing: !!prefs.marketing } });
        writeStored(state);
        closeModal();
        notify();
        toast('We could not reach our server. Cookies you switched off are already disabled on this device; we will sync your choice on your next visit.');
        applyTransition(prev, state);
        return;
      }
      if (!silent) setError('We could not save your choice (' + err.message + '). Optional cookies remain off. Please try again.');
    }).then(function () { setBusy(false); });
  }

  // ------------------------------------------------------------- events
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target : e.target.parentElement;
    if (!t) return;
    var opener = t.closest('[data-cmp-open]');
    if (opener) { e.preventDefault(); openModal(); return; }
    var act = t.closest('[data-cmp-action]');
    if (act) { e.preventDefault(); save(act.getAttribute('data-cmp-action')); return; }
    if (t.closest('[data-cmp-close]') || t === overlay) closeModal();
  });

  document.addEventListener('keydown', function (e) {
    if (overlay.hidden) return;
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab') {
      var items = focusables();
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // --------------------------------------------------------- public API
  function getConsent() {
    return state ? JSON.parse(JSON.stringify(state)) : null;
  }

  window.ConsentManager = {
    open: openModal,
    getConsent: getConsent,
    hasConsent: function (category) { return !!(state && state.preferences[category]); },
    isScriptActive: function (category) { return !!activated[category]; },
    onChange: function (fn) { listeners.push(fn); },
    policyVersion: cfg.policyVersion,
  };

  // --------------------------------------------------------------- init
  state = loadStored();
  if (state) {
    hideBanner();
    activateScripts(state.preferences);
    if (state.pending) save(state.pending.action, { necessary: true, analytics: state.pending.analytics, marketing: state.pending.marketing }, true);
  } else {
    showBanner();
  }
  notify();
})();
