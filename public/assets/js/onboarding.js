/* Account opening flow: details -> privacy notice & consents -> review -> confirmation. */
(function () {
  'use strict';

  var config = JSON.parse(document.getElementById('consent-config').textContent);
  var notice = config.privacyNotice;
  var purposes = notice.purposes;
  var form = document.getElementById('onboarding-form');
  var summary = document.getElementById('error-summary');
  var submitBtn = document.getElementById('submit-btn');
  var currentStep = 1;
  var submitting = false;
  var idempotencyKey = newKey();
  var lastPayload = null;
  var captchaPromise = null;
  var captchaBox = document.querySelector('.captcha-box');
  var CAPTCHA_TEXT = {
    idle: 'Human verification starts automatically',
    working: 'Verifying you are human…',
    done: 'Verified: you can submit your application',
    error: 'Verification failed. It will retry when you submit.',
  };

  function setCaptchaState(state) {
    captchaBox.setAttribute('data-state', state);
    byId('captcha-status').textContent = CAPTCHA_TEXT[state];
  }

  /* Solves a fresh proof-of-work challenge (once per submission attempt). */
  function ensureCaptcha() {
    if (!captchaPromise) {
      setCaptchaState('working');
      captchaPromise = window.BcbCaptcha.solve('onboarding').then(function (solution) {
        setCaptchaState('done');
        return solution;
      }, function (err) {
        captchaPromise = null;
        setCaptchaState('error');
        throw err;
      });
    }
    return captchaPromise;
  }

  var FIELDS = ['fullName', 'email', 'mobile', 'dateOfBirth', 'accountType', 'branch'];
  var LABELS = { fullName: 'Full name', email: 'Email', mobile: 'Mobile number', dateOfBirth: 'Date of birth', accountType: 'Account type', branch: 'Preferred branch' };
  var STATUS_TEXT = { acknowledged: 'Acknowledged (required)', granted: 'Consent given', denied: 'Not given', withdrawn: 'Withdrawn' };

  function newKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return node;
  }

  function byId(id) { return document.getElementById(id); }
  function nameOf(list, id) { var m = list.filter(function (x) { return x.id === id; })[0]; return m ? m.name : id; }

  // ------------------------------------------------------------ set-up
  config.bank.accountTypes.forEach(function (t) { byId('accountType').appendChild(h('option', { value: t.id, text: t.name })); });
  config.bank.branches.forEach(function (b) { byId('branch').appendChild(h('option', { value: b.id, text: b.name })); });

  var maxDob = new Date();
  maxDob.setFullYear(maxDob.getFullYear() - 18);
  byId('dateOfBirth').max = maxDob.toISOString().slice(0, 10);
  byId('dateOfBirth').min = '1906-01-01';

  purposes.forEach(function (p) {
    byId('notice-purposes').appendChild(h('li', {}, [
      h('strong', { text: p.title + (p.required ? ' (required): ' : ' (optional): ') }), p.description,
    ]));

    if (p.legalBasis === 'necessary') {
      var input = h('input', { type: 'checkbox', id: 'ack-' + p.id, 'data-ack': p.id, 'aria-describedby': 'ack-' + p.id + '-error' });
      byId('required-group').appendChild(h('div', {}, [
        h('div', { class: 'check-row' }, [
          input,
          h('label', { for: 'ack-' + p.id }, [
            'I have read the privacy notice (version ' + notice.version + ') and understand that my details will be processed for ',
            h('strong', { text: p.title }),
            '. ',
            h('span', { class: 'small muted', text: 'Data used: ' + p.dataUsed.join(', ') + '.' }),
          ]),
        ]),
        h('div', { class: 'error-text', id: 'ack-' + p.id + '-error', hidden: '' }),
      ]));
    } else {
      var toggle = h('input', { type: 'checkbox', role: 'switch', id: 'consent-' + p.id, 'data-consent': p.id, 'aria-describedby': 'consent-' + p.id + '-desc' });
      var stateText = h('div', { class: 'purpose-state muted', 'aria-live': 'polite', text: 'Not given' });
      var label = h('span', { class: 'switch-label', 'aria-hidden': 'true', text: 'Off' });
      toggle.addEventListener('change', function () {
        label.textContent = toggle.checked ? 'On' : 'Off';
        stateText.textContent = toggle.checked ? 'Consent given' : 'Not given';
        stateText.classList.toggle('muted', !toggle.checked);
      });
      byId('optional-group').appendChild(h('div', { class: 'purpose-card' }, [
        h('header', {}, [
          h('div', {}, [h('h4', { text: p.title }), h('p', { id: 'consent-' + p.id + '-desc', text: p.description })]),
          h('label', { class: 'switch', for: 'consent-' + p.id }, [
            toggle, h('span', { class: 'track' }), label, h('span', { class: 'visually-hidden', text: 'I agree to: ' + p.title }),
          ]),
        ]),
        h('div', { class: 'data-used', text: 'Data used: ' + p.dataUsed.join(', ') }),
        stateText,
      ]));
    }
  });

  // -------------------------------------------------------- validation
  function setFieldError(id, message) {
    var input = byId(id);
    var err = byId(id + '-error');
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (err) { err.textContent = message || ''; err.hidden = !message; }
  }

  function showSummary(messages) {
    summary.textContent = '';
    if (!messages || !messages.length) { summary.hidden = true; return; }
    summary.appendChild(h('strong', { text: 'Please fix the following:' }));
    summary.appendChild(h('ul', {}, messages.map(function (m) { return h('li', { text: m }); })));
    summary.hidden = false;
    summary.focus();
  }

  function normaliseMobile(raw) {
    var d = String(raw).replace(/[\s()-]/g, '');
    if (d.indexOf('+91') === 0) d = d.slice(3);
    else if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    else if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d;
  }

  function values() {
    return {
      fullName: byId('fullName').value.trim().replace(/\s+/g, ' '),
      email: byId('email').value.trim().toLowerCase(),
      mobile: normaliseMobile(byId('mobile').value),
      dateOfBirth: byId('dateOfBirth').value,
      accountType: byId('accountType').value,
      branch: byId('branch').value,
    };
  }

  function validateDetails() {
    var v = values();
    var errors = {};
    if (v.fullName.length < 2) errors.fullName = 'Enter your full name.';
    else if (!/^\p{L}[\p{L}\p{M} .'-]*$/u.test(v.fullName)) errors.fullName = 'Use letters, spaces, apostrophes, dots or hyphens only.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email)) errors.email = 'Enter a valid email address, e.g. name@example.com.';
    if (!/^[6-9]\d{9}$/.test(v.mobile)) errors.mobile = 'Enter a valid 10-digit mobile number starting with 6, 7, 8 or 9.';
    if (!v.dateOfBirth) errors.dateOfBirth = 'Enter your date of birth.';
    else if (v.dateOfBirth > byId('dateOfBirth').max) errors.dateOfBirth = 'You must be 18 or over to open an account online. Minors can apply at a branch with a guardian.';
    else if (v.dateOfBirth < byId('dateOfBirth').min) errors.dateOfBirth = 'Enter a valid date of birth.';
    if (!v.accountType) errors.accountType = 'Choose an account type.';
    if (!v.branch) errors.branch = 'Choose a branch.';
    FIELDS.forEach(function (f) { setFieldError(f, errors[f]); });
    var messages = FIELDS.filter(function (f) { return errors[f]; }).map(function (f) { return LABELS[f] + ': ' + errors[f]; });
    showSummary(messages);
    if (messages.length) {
      var first = FIELDS.filter(function (f) { return errors[f]; })[0];
      byId(first).focus();
    }
    return !messages.length;
  }

  function validateConsents() {
    var messages = [];
    purposes.filter(function (p) { return p.legalBasis === 'necessary'; }).forEach(function (p) {
      var ok = byId('ack-' + p.id).checked;
      setFieldError('ack-' + p.id, ok ? '' : 'Please confirm you have read the privacy notice. It is required to process your application.');
      if (!ok) messages.push('Please acknowledge the privacy notice for: ' + p.title + '.');
    });
    showSummary(messages);
    if (messages.length) form.querySelector('[data-ack]:not(:checked)').focus();
    return !messages.length;
  }

  // ------------------------------------------------------------- steps
  function showStep(n, initial) {
    currentStep = n;
    document.querySelectorAll('[data-step-panel]').forEach(function (panel) {
      panel.hidden = Number(panel.getAttribute('data-step-panel')) !== n;
    });
    document.querySelectorAll('#stepper li').forEach(function (li) {
      var s = Number(li.getAttribute('data-step'));
      li.classList.toggle('active', s === n);
      li.classList.toggle('done', s < n);
      if (s === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    });
    if (initial) return;
    var heading = document.querySelector('[data-step-panel="' + n + '"] h2');
    byId('stepper').scrollIntoView({ block: 'start' });
    if (heading) heading.focus({ preventScroll: true });
  }

  function payload() {
    var acknowledgements = {};
    var consents = {};
    purposes.forEach(function (p) {
      if (p.legalBasis === 'necessary') acknowledgements[p.id] = byId('ack-' + p.id).checked;
      else consents[p.id] = byId('consent-' + p.id).checked;
    });
    var v = values();
    return {
      applicant: { fullName: v.fullName, email: v.email, mobile: v.mobile, dateOfBirth: v.dateOfBirth, accountType: v.accountType, branch: v.branch },
      acknowledgements: acknowledgements,
      consents: consents,
      noticeVersion: notice.version,
    };
  }

  function renderReview() {
    var p = payload();
    var a = p.applicant;
    var details = byId('review-details');
    details.textContent = '';
    [
      ['Full name', a.fullName],
      ['Email', a.email],
      ['Mobile', '+91 ' + a.mobile],
      ['Date of birth', a.dateOfBirth],
      ['Account type', nameOf(config.bank.accountTypes, a.accountType)],
      ['Branch', nameOf(config.bank.branches, a.branch)],
    ].forEach(function (row) {
      details.appendChild(h('dt', { text: row[0] }));
      details.appendChild(h('dd', { text: row[1] }));
    });

    var consentsEl = byId('review-consents');
    consentsEl.textContent = '';
    purposes.forEach(function (purpose) {
      var status = purpose.legalBasis === 'necessary' ? 'acknowledged' : p.consents[purpose.id] ? 'granted' : 'denied';
      consentsEl.appendChild(h('dt', { text: purpose.title }));
      consentsEl.appendChild(h('dd', {}, [h('span', { class: 'status-pill status-' + status, text: STATUS_TEXT[status] })]));
    });
  }

  function goTo(target) {
    if (target > currentStep) {
      if (currentStep === 1 && !validateDetails()) return;
      if (currentStep <= 2 && target >= 3 && !validateConsents()) return;
    }
    showSummary([]);
    if (target === 3) {
      renderReview();
      ensureCaptcha().catch(function () { /* retried on submit */ });
    }
    showStep(target);
  }

  form.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-next]');
    if (!btn) return;
    e.preventDefault();
    goTo(Number(btn.getAttribute('data-next')));
  });

  // Enter key on step 1/2 should advance rather than submit.
  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && currentStep < 3) {
      e.preventDefault();
      goTo(currentStep + 1);
    }
  });

  // ------------------------------------------------------------ submit
  function applyServerErrors(details) {
    var messages = [];
    var targetStep = 3;
    (details || []).forEach(function (d) {
      var m = /^applicant\.(\w+)$/.exec(d.field);
      if (m) { setFieldError(m[1], d.message); targetStep = 1; messages.push((LABELS[m[1]] || m[1]) + ' ' + d.message); return; }
      m = /^acknowledgements\.(\w+)$/.exec(d.field);
      if (m) { setFieldError('ack-' + m[1], d.message); targetStep = Math.min(targetStep, 2); }
      messages.push(d.field + ' ' + d.message);
    });
    showStep(targetStep);
    showSummary(messages);
  }

  function renderConfirmation(body) {
    byId('conf-name').textContent = body.applicant.fullName;
    byId('conf-ref').textContent = body.referenceId;
    byId('conf-time').textContent = 'Submitted ' + new Date(body.submittedAt).toLocaleString();
    byId('conf-mobile').textContent = body.applicant.mobile;
    var tbody = byId('conf-consents');
    tbody.textContent = '';
    body.consents.forEach(function (c) {
      tbody.appendChild(h('tr', {}, [
        h('td', { text: c.title }),
        h('td', {}, [h('span', { class: 'status-pill status-' + c.status, text: STATUS_TEXT[c.status] })]),
        h('td', { text: c.noticeVersion }),
        h('td', { text: new Date(c.createdAt).toLocaleString() }),
      ]));
    });
    var link = new URL(body.manageConsentUrl, location.href).href;
    byId('conf-link').textContent = link;
    byId('conf-manage').setAttribute('href', body.manageConsentUrl);
    byId('conf-copy').addEventListener('click', function () {
      var btn = this;
      navigator.clipboard.writeText(link).then(function () { btn.textContent = 'Copied'; }, function () { btn.textContent = 'Copy failed'; });
    });
    showStep(4);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (submitting || currentStep !== 3) return;
    if (!validateConsents()) { showStep(2); return; }
    var body = payload();
    var serialised = JSON.stringify(body);
    // Same payload re-sent (e.g. after a network error) keeps the same key so
    // the server replays the original result instead of creating a duplicate.
    if (lastPayload !== null && lastPayload !== serialised) idempotencyKey = newKey();
    lastPayload = serialised;

    submitting = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying…';
    showSummary([]);

    var captchaError = false;
    ensureCaptcha().catch(function (err) {
      captchaError = true;
      throw err;
    }).then(function (solution) {
      submitBtn.textContent = 'Submitting…';
      return fetch('/api/onboarding/applications', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, 'X-Captcha-Solution': solution },
        body: serialised,
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { res: res, data: data }; });
    }).then(function (r) {
      if (r.res.ok) { renderConfirmation(r.data); return; }
      // The server has seen (and consumed) this verification; prepare a fresh one for the next attempt.
      captchaPromise = null;
      ensureCaptcha().catch(function () { /* retried on submit */ });
      var err = r.data.error || {};
      if (err.code === 'VALIDATION_FAILED') applyServerErrors(err.details);
      else if (err.code === 'NOTICE_VERSION_MISMATCH') showSummary(['Our privacy notice has been updated since you opened this page. Please reload the page and review the latest notice before submitting.']);
      else showSummary([err.message || 'Something went wrong. Please try again.']);
    }).catch(function (err) {
      if (captchaError) showSummary(['Human verification could not be completed: ' + err.message + ' Please press Submit to try again.']);
      else showSummary(['We could not reach our servers. Check your connection and press Submit again. Your application will not be duplicated.']);
    }).then(function () {
      submitting = false;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit application';
    });
  });

  showStep(1, true);
})();
