/* Consent admin dashboard. All data is rendered with textContent (never
   innerHTML), so stored values cannot inject markup or script. */
(function () {
  'use strict';

  var STATUS_TEXT = { acknowledged: 'Acknowledged', granted: 'Granted', denied: 'Not given', withdrawn: 'Withdrawn' };
  var DECISION_TEXT = { accept_all: 'Accept all', reject_optional: 'Reject optional', custom: 'Custom' };
  var ACCOUNT_TEXT = { savings: 'Savings', current: 'Current', fixed_deposit: 'Fixed deposit', recurring_deposit: 'Recurring deposit' };
  var EVENT_TEXT = {
    CUSTOMER_APPLICATION_SUBMITTED: 'Application submitted',
    CONSENT_RECORDED: 'Consent recorded',
    CONSENT_GRANTED: 'Consent granted',
    CONSENT_WITHDRAWN: 'Consent withdrawn',
    COOKIE_CONSENT_GIVEN: 'Cookie consent given',
    COOKIE_CONSENT_CHANGED: 'Cookie consent changed',
    PII_REVEALED: 'PII revealed to staff',
    ADMIN_LOGIN: 'Admin signed in',
    ADMIN_LOGIN_FAILED: 'Failed sign-in',
    ADMIN_LOGOUT: 'Admin signed out',
    POLICY_VERSION_PUBLISHED: 'Policy version published',
  };

  var purposes = [];
  var branchNames = {};
  var activeTab = 'overview';
  var lastFocus = null;

  function byId(id) { return document.getElementById(id); }
  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }
  function fmt(ts) { return ts ? new Date(ts).toLocaleString() : '–'; }
  function pct(n, total) { return total ? Math.round((n / total) * 100) + '%' : '–'; }
  function pill(status) { return h('span', { class: 'status-pill status-' + status, text: STATUS_TEXT[status] || status }); }
  function yesNo(v) { return h('span', { class: v ? 'yes' : 'no', text: v ? 'Allowed' : 'Off' }); }
  function empty(tbody, cols, text) { tbody.appendChild(h('tr', {}, [h('td', { colspan: String(cols), class: 'empty', text: text })])); }

  function showAppError(message) {
    byId('app-error').textContent = message || '';
    byId('app-error').hidden = !message;
  }

  function api(path, options) {
    options = options || {};
    var init = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
    if (options.body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('Session expired. Please sign in again.'); }
        if (!res.ok) {
          var err = new Error((data.error && data.error.message) || 'Request failed (' + res.status + ')');
          err.details = data.error && data.error.details;
          throw err;
        }
        return data;
      });
    });
  }

  function detailsText(d) {
    if (!d || typeof d !== 'object') return '';
    return Object.keys(d).filter(function (k) { return d[k] !== null && d[k] !== undefined; }).map(function (k) {
      var v = d[k];
      if (typeof v === 'object') v = Array.isArray(v) ? v.join(', ') : Object.keys(v).map(function (x) { return x + '=' + v[x]; }).join(' ');
      return k + ': ' + v;
    }).join(' · ');
  }

  // ------------------------------------------------------------- auth
  function showLogin() {
    byId('app-view').hidden = true;
    byId('login-view').hidden = false;
    closeDrawer();
    byId('login-username').focus();
  }

  function showApp(me) {
    byId('login-view').hidden = true;
    byId('app-view').hidden = false;
    byId('pv-username').textContent = 'Signed in as ' + me.username;
    byId('dev-password-warning').hidden = !me.usingDevPassword;
    loadTab(activeTab);
  }

  byId('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = byId('login-btn');
    var err = byId('login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    window.BcbCaptcha.solve('admin_login')
      .then(function (solution) {
        btn.textContent = 'Signing in…';
        return api('/api/admin/login', { method: 'POST', body: { username: byId('login-username').value, password: byId('login-password').value, captcha: solution } });
      })
      .then(function () {
        byId('login-password').value = '';
        return api('/api/admin/me');
      })
      .then(showApp)
      .catch(function (ex) { err.textContent = ex.message; err.hidden = false; })
      .then(function () { btn.disabled = false; btn.textContent = 'Sign in'; });
  });

  byId('logout-btn').addEventListener('click', function () {
    api('/api/admin/logout', { method: 'POST', body: {} }).catch(function () {}).then(showLogin);
  });

  byId('refresh-btn').addEventListener('click', function () { loadTab(activeTab); });

  // ------------------------------------------------------------- tabs
  document.querySelectorAll('[data-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () { selectTab(tab.getAttribute('data-tab')); });
    tab.addEventListener('keydown', function (e) {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('[data-tab]'));
      var i = tabs.indexOf(tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        var next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        selectTab(next.getAttribute('data-tab'));
      }
    });
  });

  function selectTab(name) {
    activeTab = name;
    document.querySelectorAll('[data-tab]').forEach(function (t) {
      var on = t.getAttribute('data-tab') === name;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('[data-panel]').forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== name; });
    loadTab(name);
  }

  function loadTab(name) {
    showAppError('');
    var loader = { overview: loadOverview, customers: loadCustomers, cookies: loadCookies, audit: loadAudit }[name];
    loader().catch(function (e) { showAppError(e.message); });
  }

  // --------------------------------------------------------- overview
  function kpi(label, value, sub) {
    return h('div', { class: 'kpi' }, [h('span', { class: 'label', text: label }), h('span', { class: 'value', text: String(value) }), sub ? h('span', { class: 'sub', text: sub }) : null]);
  }
  function miniTile(label, value, sub) {
    return h('div', { class: 'mini-tile' }, [h('span', { class: 'label', text: label }), h('span', { class: 'value', text: String(value) }), sub ? h('span', { class: 'sub', text: sub }) : null]);
  }

  function loadOverview() {
    return Promise.all([api('/api/admin/stats'), api('/api/admin/audit?limit=8'), api('/api/admin/policies')]).then(function (r) {
      var s = r[0];
      var kpis = byId('kpis');
      kpis.textContent = '';
      var optionalGranted = 0;
      var optionalTotal = 0;
      Object.keys(s.byPurpose).forEach(function (k) {
        var p = s.byPurpose[k];
        if (p.legalBasis === 'consent') { optionalGranted += p.granted; optionalTotal += p.granted + p.denied + p.withdrawn; }
      });
      kpis.appendChild(kpi('Customers onboarded', s.customers));
      kpis.appendChild(kpi('Consent records', s.consentRecords, optionalGranted + ' of ' + optionalTotal + ' optional consents granted'));
      kpis.appendChild(kpi('Consent changes logged', s.consentEvents, 'creations + updates'));
      kpis.appendChild(kpi('Cookie decisions', s.cookies.visitors, s.cookies.totalRecords + ' records incl. changes'));
      kpis.appendChild(kpi('Audit entries', s.auditEntries, 'hash-chained'));

      var bars = byId('purpose-bars');
      bars.textContent = '';
      Object.keys(s.byPurpose).forEach(function (id) {
        var p = s.byPurpose[id];
        var keys = p.legalBasis === 'necessary' ? ['acknowledged'] : ['granted', 'denied', 'withdrawn'];
        var total = keys.reduce(function (sum, k) { return sum + p[k]; }, 0);
        var stack = h('div', { class: 'stack', role: 'img', 'aria-label': p.title + ': ' + keys.map(function (k) { return STATUS_TEXT[k] + ' ' + p[k]; }).join(', ') });
        keys.forEach(function (k) {
          if (!p[k]) return;
          var seg = h('div', { class: 'seg seg-' + k, title: STATUS_TEXT[k] + ': ' + p[k] + ' (' + pct(p[k], total) + ')' });
          seg.style.flexGrow = String(p[k]);
          stack.appendChild(seg);
        });
        bars.appendChild(h('div', { class: 'purpose-row' }, [
          h('div', { class: 'name' }, [p.title, h('span', { text: total + ' customers · ' + (p.legalBasis === 'necessary' ? 'required' : 'optional') })]),
          stack,
          h('div', { class: 'legend' }, keys.map(function (k) {
            return h('span', {}, [h('i', { class: 'dot-' + k }), STATUS_TEXT[k] + ' ', h('b', { text: String(p[k]) }), ' (' + pct(p[k], total) + ')']);
          })),
        ]));
      });

      var c = s.cookies;
      var ct = byId('cookie-tiles');
      ct.textContent = '';
      ct.appendChild(miniTile('Accept all', c.acceptAll, pct(c.acceptAll, c.visitors)));
      ct.appendChild(miniTile('Reject optional', c.rejectOptional, pct(c.rejectOptional, c.visitors)));
      ct.appendChild(miniTile('Custom', c.custom, pct(c.custom, c.visitors)));
      ct.appendChild(miniTile('Analytics allowed', c.analyticsGranted, pct(c.analyticsGranted, c.visitors) + ' of visitors'));
      ct.appendChild(miniTile('Marketing allowed', c.marketingGranted, pct(c.marketingGranted, c.visitors) + ' of visitors'));
      ct.appendChild(miniTile('On outdated policy', c.outdatedPolicy, 'will be asked again'));

      var tt = byId('telemetry-tiles');
      tt.textContent = '';
      tt.appendChild(miniTile('Analytics events', s.telemetry.analytics, 'accepted with consent'));
      tt.appendChild(miniTile('Marketing events', s.telemetry.marketing, 'accepted with consent'));

      var list = byId('recent-activity');
      list.textContent = '';
      if (!r[1].entries.length) list.appendChild(h('li', { class: 'muted', text: 'No activity yet.' }));
      r[1].entries.forEach(function (e) {
        list.appendChild(h('li', {}, [h('time', { datetime: e.occurredAt, text: fmt(e.occurredAt) }), h('span', {}, [h('strong', { text: EVENT_TEXT[e.action] || e.action }), ' · ' + e.actorType + (e.details.purpose ? ' · ' + e.details.purpose : '') + (e.details.referenceId ? ' · ' + e.details.referenceId : '')])]));
      });

      var pr = byId('policy-rows');
      pr.textContent = '';
      r[2].policies.forEach(function (p) {
        pr.appendChild(h('tr', {}, [
          h('td', { text: p.policyType === 'cookie_policy' ? 'Cookie policy' : 'Privacy notice' }),
          h('td', { text: p.version }), h('td', { text: p.effectiveFrom }),
          h('td', { class: 'mono', text: p.contentHash.slice(0, 16) + '…' }),
        ]));
      });
    });
  }

  // -------------------------------------------------------- customers
  function loadCustomers() {
    var sel = byId('cf-purpose');
    var prep = purposes.length ? Promise.resolve() : api('/api/consent-config').then(function (cfg) {
      purposes = cfg.privacyNotice.purposes;
      cfg.bank.branches.forEach(function (b) { branchNames[b.id] = b.name; });
      purposes.forEach(function (p) { sel.appendChild(h('option', { value: p.id, text: p.title })); });
    });
    return prep.then(function () {
      var qs = new URLSearchParams();
      if (byId('cf-q').value.trim()) qs.set('q', byId('cf-q').value.trim());
      if (sel.value) qs.set('purpose', sel.value);
      if (byId('cf-status').value) qs.set('status', byId('cf-status').value);
      return api('/api/admin/customers?' + qs.toString());
    }).then(function (data) {
      var tbody = byId('customer-rows');
      tbody.textContent = '';
      byId('customer-count').textContent = data.customers.length + ' customer' + (data.customers.length === 1 ? '' : 's') + ' found';
      if (!data.customers.length) empty(tbody, 8, 'No customers match these filters.');
      data.customers.forEach(function (c) {
        var open = function () { openCustomer(c.id); };
        var tr = h('tr', { onclick: open }, [
          h('td', {}, [h('button', { type: 'button', class: 'row-link', text: c.referenceId, 'aria-label': 'Open ' + c.referenceId })]),
          h('td', { text: c.fullName }), h('td', { text: c.email }), h('td', { text: c.mobile }),
          h('td', { text: ACCOUNT_TEXT[c.accountType] || c.accountType }),
          h('td', {}, [pill(c.consents.marketing_communications)]),
          h('td', {}, [pill(c.consents.third_party_sharing)]),
          h('td', { text: fmt(c.createdAt) }),
        ]);
        tbody.appendChild(tr);
      });
    });
  }

  byId('customer-filters').addEventListener('submit', function (e) { e.preventDefault(); loadTab('customers'); });
  byId('customer-filters').addEventListener('reset', function () { setTimeout(function () { loadTab('customers'); }, 0); });

  function openCustomer(id) {
    api('/api/admin/customers/' + encodeURIComponent(id)).then(function (data) {
      var c = data.customer;
      var body = byId('drawer-body');
      body.textContent = '';
      var piiList = h('dl', { class: 'kv' }, [
        h('dt', { text: 'Reference' }), h('dd', { text: c.referenceId }),
        h('dt', { text: 'Name' }), h('dd', { text: c.fullName, 'data-pii': 'fullName' }),
        h('dt', { text: 'Email' }), h('dd', { text: c.email, 'data-pii': 'email' }),
        h('dt', { text: 'Mobile' }), h('dd', { text: c.mobile, 'data-pii': 'mobile' }),
        h('dt', { text: 'Date of birth' }), h('dd', { text: c.dateOfBirth, 'data-pii': 'dateOfBirth' }),
        h('dt', { text: 'Account type' }), h('dd', { text: ACCOUNT_TEXT[c.accountType] || c.accountType }),
        h('dt', { text: 'Branch' }), h('dd', { text: branchNames[c.branch] || c.branch }),
        h('dt', { text: 'Status' }), h('dd', { text: c.applicationStatus }),
        h('dt', { text: 'Submitted' }), h('dd', { text: fmt(c.createdAt) }),
      ]);
      var reason = h('input', { type: 'text', id: 'reveal-reason', maxlength: '200', placeholder: 'e.g. Customer called to verify identity (ticket #123)' });
      var revealMsg = h('p', { class: 'small muted', text: 'Contact details are masked. Revealing them requires a reason and is recorded in the audit trail.' });
      var revealForm = h('form', { class: 'reveal-form' }, [
        h('div', { class: 'field' }, [h('label', { for: 'reveal-reason', text: 'Reason for viewing full details' }), reason]),
        h('button', { type: 'submit', class: 'btn btn-secondary btn-sm', text: 'Reveal full details' }),
      ]);
      revealForm.addEventListener('submit', function (e) {
        e.preventDefault();
        api('/api/admin/customers/' + encodeURIComponent(id) + '/reveal', { method: 'POST', body: { reason: reason.value } }).then(function (r) {
          Object.keys(r.pii).forEach(function (k) {
            var dd = piiList.querySelector('[data-pii="' + k + '"]');
            if (dd) dd.textContent = r.pii[k];
          });
          revealMsg.textContent = 'Full details revealed. This access has been logged.';
          revealForm.hidden = true;
        }).catch(function (ex) {
          revealMsg.textContent = ex.details ? ex.details.map(function (d) { return d.field + ' ' + d.message; }).join('; ') : ex.message;
        });
      });

      var consentRows = h('tbody', {}, c.consentRecords.map(function (r) {
        return h('tr', {}, [h('td', { text: r.title }), h('td', { text: r.legalBasis === 'necessary' ? 'Necessary' : 'Consent' }), h('td', {}, [pill(r.status)]), h('td', { text: 'v' + r.noticeVersion }), h('td', { text: r.source }), h('td', { text: fmt(r.updatedAt) })]);
      }));

      body.appendChild(h('h3', { text: 'Customer' }));
      body.appendChild(piiList);
      body.appendChild(revealMsg);
      body.appendChild(revealForm);
      body.appendChild(h('h3', { text: 'Current consents' }));
      body.appendChild(h('div', { class: 'table-wrap' }, [h('table', {}, [
        h('thead', {}, [h('tr', {}, ['Purpose', 'Basis', 'Status', 'Notice', 'Source', 'Updated'].map(function (t) { return h('th', { text: t }); }))]),
        consentRows,
      ])]));
      body.appendChild(h('h3', { text: 'Consent history' }));
      body.appendChild(h('ul', { class: 'timeline' }, c.history.map(function (e) {
        return h('li', {}, [h('time', { text: fmt(e.createdAt) }), h('strong', { text: e.title }), ': ' + (e.previousStatus ? STATUS_TEXT[e.previousStatus] + ' → ' : 'recorded as ') + STATUS_TEXT[e.newStatus] + ' (' + e.source + ', notice v' + e.noticeVersion + ')']);
      })));
      body.appendChild(h('h3', { text: 'Audit trail for this customer' }));
      body.appendChild(auditTable(data.audit));
      openDrawer('Customer ' + c.referenceId);
    }).catch(function (e) { showAppError(e.message); });
  }

  // ---------------------------------------------------------- cookies
  function loadCookies() {
    var qs = new URLSearchParams();
    if (byId('kf-visitor').value.trim()) qs.set('visitor', byId('kf-visitor').value.trim());
    if (byId('kf-action').value) qs.set('action', byId('kf-action').value);
    if (byId('kf-category').value) qs.set('category', byId('kf-category').value);
    if (byId('kf-history').value === 'all') qs.set('history', 'all');
    return api('/api/admin/cookie-consents?' + qs.toString()).then(function (data) {
      var tbody = byId('cookie-rows');
      tbody.textContent = '';
      byId('cookie-count').textContent = data.consents.length + ' record' + (data.consents.length === 1 ? '' : 's');
      if (!data.consents.length) empty(tbody, 8, 'No cookie consents match these filters.');
      data.consents.forEach(function (c) {
        tbody.appendChild(h('tr', { onclick: function () { openVisitor(c.visitorId); } }, [
          h('td', {}, [h('button', { type: 'button', class: 'row-link mono', text: c.visitorId.slice(0, 8) + '…', 'aria-label': 'Open visitor ' + c.visitorId })]),
          h('td', { text: DECISION_TEXT[c.action] }),
          h('td', {}, [h('span', { class: 'yes', text: 'Always' })]),
          h('td', {}, [yesNo(c.preferences.analytics)]),
          h('td', {}, [yesNo(c.preferences.marketing)]),
          h('td', { text: 'v' + c.policyVersion + (c.isCurrentPolicy ? '' : ' (outdated)') }),
          h('td', { text: fmt(c.recordedAt) }),
          h('td', { text: String(c.historyCount) }),
        ]));
      });
    });
  }

  byId('cookie-filters').addEventListener('submit', function (e) { e.preventDefault(); loadTab('cookies'); });
  byId('cookie-filters').addEventListener('reset', function () { setTimeout(function () { loadTab('cookies'); }, 0); });

  function openVisitor(visitorId) {
    api('/api/admin/cookie-consents/visitors/' + encodeURIComponent(visitorId)).then(function (data) {
      var body = byId('drawer-body');
      body.textContent = '';
      body.appendChild(h('dl', { class: 'kv' }, [
        h('dt', { text: 'Visitor ID' }), h('dd', { class: 'mono', text: data.visitorId }),
        h('dt', { text: 'Decisions recorded' }), h('dd', { text: String(data.history.length) }),
      ]));
      body.appendChild(h('p', { class: 'small muted', text: 'Visitors are pseudonymous: we store a random visitor ID, a keyed hash of the IP address and a truncated user agent, never a name or email.' }));
      body.appendChild(h('h3', { text: 'Preference history (newest first)' }));
      body.appendChild(h('div', { class: 'table-wrap' }, [h('table', {}, [
        h('thead', {}, [h('tr', {}, ['Recorded', 'Decision', 'Analytics', 'Marketing', 'Policy', 'Consent ID'].map(function (t) { return h('th', { text: t }); }))]),
        h('tbody', {}, data.history.map(function (c) {
          return h('tr', {}, [h('td', { text: fmt(c.recordedAt) }), h('td', { text: DECISION_TEXT[c.action] }), h('td', {}, [yesNo(c.preferences.analytics)]), h('td', {}, [yesNo(c.preferences.marketing)]), h('td', { text: 'v' + c.policyVersion }), h('td', { class: 'mono', text: c.id.slice(0, 8) + '…' })]);
        })),
      ])]));
      body.appendChild(h('h3', { text: 'Audit trail' }));
      body.appendChild(auditTable(data.audit));
      openDrawer('Cookie consent: visitor ' + visitorId.slice(0, 8));
    }).catch(function (e) { showAppError(e.message); });
  }

  // ------------------------------------------------------------ audit
  function auditTable(entries) {
    var tbody = h('tbody');
    if (!entries.length) empty(tbody, 7, 'No audit entries.');
    entries.forEach(function (e) {
      tbody.appendChild(h('tr', {}, [
        h('td', { text: String(e.id) }),
        h('td', { text: fmt(e.occurredAt) }),
        h('td', { text: e.actorType + (e.actorId ? ' · ' + (e.actorId.length > 12 ? e.actorId.slice(0, 8) + '…' : e.actorId) : '') }),
        h('td', {}, [h('strong', { text: EVENT_TEXT[e.action] || e.action })]),
        h('td', { text: e.entityType }),
        h('td', { class: 'details-cell', text: detailsText(e.details) }),
        h('td', { class: 'mono', text: e.hash.slice(0, 10) + '…' }),
      ]));
    });
    return h('div', { class: 'table-wrap' }, [h('table', {}, [
      h('thead', {}, [h('tr', {}, ['#', 'Time', 'Actor', 'Event', 'Entity', 'Details', 'Hash'].map(function (t) { return h('th', { text: t }); }))]),
      tbody,
    ])]);
  }

  function loadAudit() {
    var sel = byId('af-action');
    var qs = new URLSearchParams();
    if (sel.value) qs.set('action', sel.value);
    if (byId('af-entity').value) qs.set('entityType', byId('af-entity').value);
    return api('/api/admin/audit?' + qs.toString()).then(function (data) {
      var current = sel.value;
      sel.textContent = '';
      sel.appendChild(h('option', { value: '', text: 'All events' }));
      data.actions.forEach(function (a) { sel.appendChild(h('option', { value: a, text: EVENT_TEXT[a] || a })); });
      sel.value = current;
      var tbody = byId('audit-rows');
      tbody.textContent = '';
      var table = auditTable(data.entries);
      Array.prototype.slice.call(table.querySelector('tbody').children).forEach(function (tr) { tbody.appendChild(tr); });
    });
  }

  byId('audit-filters').addEventListener('submit', function (e) { e.preventDefault(); loadTab('audit'); });
  byId('verify-btn').addEventListener('click', function () {
    var box = byId('verify-result');
    api('/api/admin/audit/verify').then(function (r) {
      box.className = 'callout ' + (r.valid ? 'callout-success' : 'callout-danger');
      box.textContent = r.valid
        ? 'Integrity verified: all ' + r.checked + ' audit entries form an unbroken hash chain.'
        : 'Integrity check FAILED at entry #' + r.brokenAtId + ' (after ' + r.checked + ' valid entries). The audit log may have been tampered with.';
      box.hidden = false;
    }).catch(function (e) { showAppError(e.message); });
  });

  // ----------------------------------------------------------- drawer
  function openDrawer(title) {
    lastFocus = document.activeElement;
    byId('drawer-title').textContent = title;
    byId('drawer').hidden = false;
    byId('drawer-close').focus();
  }
  function closeDrawer() {
    if (byId('drawer').hidden) return;
    byId('drawer').hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  byId('drawer-close').addEventListener('click', closeDrawer);
  byId('drawer').addEventListener('click', function (e) { if (e.target === byId('drawer')) closeDrawer(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  // ------------------------------------------------------------- init
  api('/api/admin/me').then(showApp).catch(showLogin);
})();
