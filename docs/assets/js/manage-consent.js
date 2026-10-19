/* Customer self-service consent management. The token lives in the URL
   fragment (#token=...), which browsers never send to the server or in the
   Referer header; it is sent only as an Authorization header to the API. */
(function () {
  'use strict';

  var config = JSON.parse(document.getElementById('consent-config').textContent);
  var purposes = config.privacyNotice.purposes;
  var STATUS_TEXT = { acknowledged: 'Acknowledged (required)', granted: 'Consent given', denied: 'Not given', withdrawn: 'Withdrawn' };
  var SOURCE_TEXT = { web_onboarding: 'Online application', self_service: 'Self-service' };

  function byId(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k]; else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  // Move the token out of the address bar immediately so it does not linger in
  // browser history, screenshots or synced tabs; keep it for this tab only.
  var TOKEN_KEY = 'bcb-manage-token';
  var token = (new URLSearchParams(location.hash.slice(1))).get('token');
  if (token) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch (e) { /* storage unavailable */ }
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    try { token = sessionStorage.getItem(TOKEN_KEY); } catch (e) { token = null; }
  }
  if (!token) { byId('mc-no-token').hidden = false; return; }

  function showError(message) {
    byId('mc-error').textContent = message || '';
    byId('mc-error').hidden = !message;
  }

  function api(method, body) {
    return fetch('/api/self/consents', {
      method: method,
      credentials: 'omit',
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data.error && data.error.message) || 'Request failed');
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function render(data) {
    byId('mc-panel').hidden = false;
    byId('mc-name').textContent = data.applicant.fullName;
    byId('mc-ref').textContent = data.referenceId;
    byId('mc-contact').textContent = data.applicant.email + ' · ' + data.applicant.mobile;
    byId('mc-version').textContent = data.currentNoticeVersion;

    var required = byId('mc-required');
    var optional = byId('mc-optional');
    required.textContent = '';
    optional.textContent = '';
    data.consents.forEach(function (c) {
      var purpose = purposes.filter(function (p) { return p.id === c.purpose; })[0] || { description: '' };
      var meta = h('div', { class: 'purpose-state muted', text: STATUS_TEXT[c.status] + ' · updated ' + new Date(c.updatedAt).toLocaleString() + ' · notice v' + c.noticeVersion });
      if (c.legalBasis === 'necessary') {
        required.appendChild(h('div', { class: 'purpose-card' }, [
          h('header', {}, [h('div', {}, [h('h4', { text: c.title }), h('p', { text: purpose.description })]), h('span', { class: 'status-pill status-acknowledged', text: 'Required' })]),
          meta,
        ]));
        return;
      }
      var toggle = h('input', { type: 'checkbox', role: 'switch', id: 'mc-' + c.purpose, 'data-purpose': c.purpose });
      toggle.checked = c.status === 'granted';
      var label = h('span', { class: 'switch-label', 'aria-hidden': 'true', text: toggle.checked ? 'On' : 'Off' });
      toggle.addEventListener('change', function () { label.textContent = toggle.checked ? 'On' : 'Off'; });
      optional.appendChild(h('div', { class: 'purpose-card' }, [
        h('header', {}, [
          h('div', {}, [h('h4', { text: c.title }), h('p', { text: purpose.description })]),
          h('label', { class: 'switch', for: 'mc-' + c.purpose }, [toggle, h('span', { class: 'track' }), label, h('span', { class: 'visually-hidden', text: c.title })]),
        ]),
        meta,
      ]));
    });

    var tbody = byId('mc-history');
    tbody.textContent = '';
    data.history.forEach(function (e) {
      tbody.appendChild(h('tr', {}, [
        h('td', { text: new Date(e.createdAt).toLocaleString() }),
        h('td', { text: e.title }),
        h('td', { text: (e.previousStatus ? STATUS_TEXT[e.previousStatus] + ' → ' : 'Recorded: ') + STATUS_TEXT[e.newStatus] }),
        h('td', { text: SOURCE_TEXT[e.source] || e.source }),
        h('td', { text: 'v' + e.noticeVersion }),
      ]));
    });
  }

  api('GET').then(render).catch(function (err) {
    if (err.status === 401) { try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }
    showError(err.status === 401 ? 'This consent management link is invalid or has expired. Please contact customer support.' : 'We could not load your consents. ' + err.message);
  });

  byId('mc-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = byId('mc-save');
    var consents = {};
    document.querySelectorAll('[data-purpose]').forEach(function (t) { consents[t.getAttribute('data-purpose')] = t.checked; });
    btn.disabled = true;
    showError('');
    byId('mc-success').hidden = true;
    api('PUT', { consents: consents, noticeVersion: config.privacyNotice.version }).then(function (data) {
      render(data);
      var msg = data.changes.length
        ? 'Saved. ' + data.changes.map(function (c) {
            var t = (purposes.filter(function (p) { return p.id === c.purpose; })[0] || {}).title || c.purpose;
            return t + ': ' + STATUS_TEXT[c.to].toLowerCase();
          }).join('; ') + '.'
        : 'No changes: your choices were already saved.';
      byId('mc-success').textContent = msg;
      byId('mc-success').hidden = false;
    }).catch(function (err) {
      showError('We could not save your choices. ' + err.message);
    }).then(function () { btn.disabled = false; });
  });
})();
