/*
 * Mock API: used ONLY by the static GitHub Pages build.
 *
 * GitHub Pages cannot run the Node.js backend, so this script intercepts
 * fetch('/api/...') calls in the browser and answers them with the same
 * contract as the real server (server/routes.js): same validation rules,
 * consistency checks, idempotency, duplicate detection, consent history and
 * hash-chained audit trail. Data lives in this browser's localStorage.
 *
 * Not done here (only the real server does it): encryption at rest, HttpOnly
 * sessions, rate limiting and server-side secrets. See README.md.
 */
(function () {
  'use strict';

  var CFG = window.DEMO_MOCK_CONFIG;
  if (!CFG) return;
  var STORE_KEY = 'bcb-demo-db-v1';
  var SESSION_KEY = 'bcb-demo-admin-session';
  var CAPTCHA_MAX = 50000;
  var cookiePolicy = CFG.consent.cookiePolicy;
  var notice = CFG.consent.privacyNotice;
  var bank = CFG.consent.bank;
  var PURPOSES = notice.purposes;
  var purposeById = {};
  PURPOSES.forEach(function (p) { purposeById[p.id] = p; });
  var OPTIONAL = PURPOSES.filter(function (p) { return p.legalBasis === 'consent'; }).map(function (p) { return p.id; });
  var NECESSARY = PURPOSES.filter(function (p) { return p.legalBasis === 'necessary'; }).map(function (p) { return p.id; });

  // ------------------------------------------------------------ utilities
  /* Compact synchronous SHA-256 (public-domain algorithm), input is a JS string. */
  function sha256(str) {
    var ascii = unescape(encodeURIComponent(str));
    function rr(v, a) { return (v >>> a) | (v << (32 - a)); }
    var maxWord = Math.pow(2, 32);
    var result = '';
    var words = [];
    var bitLength = ascii.length * 8;
    var hash = [];
    var k = [];
    var primeCounter = 0;
    var isComposite = {};
    var i, j;
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (Math.pow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (Math.pow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    hash = hash.slice(0, 8);
    ascii += '\x80';
    while (ascii.length % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii.length; i++) {
      j = ascii.charCodeAt(i);
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words.length] = (bitLength / maxWord) | 0;
    words[words.length] = bitLength;
    for (j = 0; j < words.length;) {
      var w = words.slice(j, j += 16);
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15];
        var w2 = w[i - 2];
        var a = hash[0];
        var e = hash[4];
        var temp1 = hash[7] + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
          (w[i] = i < 16 ? w[i] : (w[i - 16] + (rr(w15, 7) ^ rr(w15, 18) ^ (w15 >>> 3)) + w[i - 7] + (rr(w2, 17) ^ rr(w2, 19) ^ (w2 >>> 10))) | 0);
        var temp2 = (rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j + 1; j--) {
        var b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function randomBytes(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return a;
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    var b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function randomToken() {
    return btoa(String.fromCharCode.apply(null, randomBytes(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  var clock = null; // overridden while seeding historical demo data
  function now() { return (clock || new Date()).toISOString(); }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function ApiError(status, code, message, details) {
    this.status = status;
    this.code = code;
    this.message = message;
    this.details = details;
  }

  // ----------------------------------------------------------- storage
  function emptyDb() {
    return {
      version: 1, secret: randomToken(), customers: [], consents: [], events: [], cookies: [], audit: [],
      idempotency: {}, telemetry: { analytics: 0, marketing: 0 }, policies: [], seq: { event: 0, audit: 0, cookie: 0 },
      captchaUsed: {},
    };
  }
  var memoryOnly = false;
  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(STORE_KEY));
      return d && d.version === 1 ? d : null;
    } catch (e) {
      memoryOnly = true;
      return null;
    }
  }
  function save() {
    if (memoryOnly) return;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(db)); } catch (e) { memoryOnly = true; }
  }
  /* Runs fn atomically: on any error the in-memory DB is restored. */
  function transaction(fn) {
    var snapshot = JSON.stringify(db);
    try {
      var r = fn();
      save();
      return r;
    } catch (err) {
      db = JSON.parse(snapshot);
      throw err;
    }
  }

  // -------------------------------------------------------------- audit
  function entryHash(prevHash, e) {
    return sha256(db.secret + '|' + [prevHash, e.occurredAt, e.actorType, e.actorId || '', e.action, e.entityType, e.entityId || '', JSON.stringify(e.details)].join('|'));
  }
  function appendAudit(actorType, actorId, action, entityType, entityId, details) {
    var last = db.audit[db.audit.length - 1];
    var prevHash = last ? last.hash : 'GENESIS';
    var e = { id: ++db.seq.audit, occurredAt: now(), actorType: actorType, actorId: actorId || null, action: action, entityType: entityType, entityId: entityId || null, details: details || {} };
    e.prevHash = prevHash;
    e.hash = entryHash(prevHash, e);
    db.audit.push(e);
  }
  function verifyChain() {
    var prev = 'GENESIS';
    for (var i = 0; i < db.audit.length; i++) {
      var e = db.audit[i];
      if (e.prevHash !== prev || entryHash(prev, e) !== e.hash) return { valid: false, checked: i, brokenAtId: e.id };
      prev = e.hash;
    }
    return { valid: true, checked: db.audit.length, brokenAtId: null };
  }
  function auditDto(e) {
    return { id: e.id, occurredAt: e.occurredAt, actorType: e.actorType, actorId: e.actorId, action: e.action, entityType: e.entityType, entityId: e.entityId, details: e.details, hash: e.hash };
  }
  function listAudit(f) {
    f = f || {};
    var out = [];
    for (var i = db.audit.length - 1; i >= 0 && out.length < (f.limit || 200); i--) {
      var e = db.audit[i];
      if (f.action && e.action !== f.action) continue;
      if (f.entityType && e.entityType !== f.entityType) continue;
      if (f.entityId && e.entityId !== f.entityId) continue;
      out.push(auditDto(e));
    }
    return out;
  }

  // --------------------------------------------------------- validation
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var NAME_RE = /^\p{L}[\p{L}\p{M} .'-]*$/u;
  var EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

  function Validator() { this.errors = []; }
  Validator.prototype.fail = function (field, message) { this.errors.push({ field: field, message: message }); };
  Validator.prototype.object = function (value, field, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { this.fail(field, 'must be an object'); return null; }
    var self = this;
    Object.keys(value).forEach(function (k) { if (keys.indexOf(k) < 0) self.fail(field ? field + '.' + k : k, 'is not an allowed field'); });
    return value;
  };
  Validator.prototype.boolean = function (value, field) {
    if (typeof value !== 'boolean') { this.fail(field, 'must be true or false'); return undefined; }
    return value;
  };
  Validator.prototype.string = function (value, field, min, max) {
    if (typeof value !== 'string') { this.fail(field, 'must be a string'); return undefined; }
    var v = value.trim().replace(/\s+/g, ' ');
    if (v.length < min) { this.fail(field, min === 1 ? 'is required' : 'must be at least ' + min + ' characters'); return undefined; }
    if (v.length > max) { this.fail(field, 'must be at most ' + max + ' characters'); return undefined; }
    return v;
  };
  Validator.prototype.oneOf = function (value, field, allowed) {
    if (allowed.indexOf(value) < 0) { this.fail(field, 'must be one of: ' + allowed.join(', ')); return undefined; }
    return value;
  };
  Validator.prototype.done = function () {
    if (this.errors.length) throw new ApiError(422, 'VALIDATION_FAILED', 'Some fields are invalid', this.errors);
  };

  function assertVersion(received, current, code, label) {
    if (received !== current) {
      throw new ApiError(409, code, 'The ' + label + ' has been updated (current version ' + current + '). Please review the latest version and try again.', { currentVersion: current, receivedVersion: received === undefined ? null : received });
    }
  }

  function normaliseMobile(raw) {
    var d = String(raw).replace(/[\s()-]/g, '');
    if (d.indexOf('+91') === 0) d = d.slice(3);
    else if (d.length === 12 && d.indexOf('91') === 0) d = d.slice(2);
    else if (d.length === 11 && d.charAt(0) === '0') d = d.slice(1);
    return d;
  }

  function validateCookieConsent(body) {
    var v = new Validator();
    v.object(body, '', ['visitorId', 'preferences', 'action', 'policyVersion']);
    var visitorId = null;
    if (body.visitorId !== undefined && body.visitorId !== null) {
      if (typeof body.visitorId !== 'string' || !UUID_RE.test(body.visitorId)) v.fail('visitorId', 'must be a UUID v4');
      else visitorId = body.visitorId.toLowerCase();
    }
    var prefs = v.object(body.preferences, 'preferences', ['necessary', 'analytics', 'marketing']) || {};
    var analytics = v.boolean(prefs.analytics, 'preferences.analytics');
    var marketing = v.boolean(prefs.marketing, 'preferences.marketing');
    if (prefs.necessary !== undefined && prefs.necessary !== true) v.fail('preferences.necessary', 'strictly necessary cookies cannot be disabled');
    var action = v.oneOf(body.action, 'action', ['accept_all', 'reject_optional', 'custom']);
    if (typeof body.policyVersion !== 'string') v.fail('policyVersion', 'is required');
    v.done();
    if (action === 'accept_all' && !(analytics && marketing)) throw new ApiError(422, 'INCONSISTENT_CONSENT', 'accept_all requires every optional category to be enabled');
    if (action === 'reject_optional' && (analytics || marketing)) throw new ApiError(422, 'INCONSISTENT_CONSENT', 'reject_optional requires every optional category to be disabled');
    assertVersion(body.policyVersion, cookiePolicy.version, 'POLICY_VERSION_MISMATCH', 'cookie policy');
    return { visitorId: visitorId, analytics: analytics, marketing: marketing, action: action, policyVersion: body.policyVersion };
  }

  function validateOnboarding(body) {
    var v = new Validator();
    v.object(body, '', ['applicant', 'acknowledgements', 'consents', 'noticeVersion']);
    var a = v.object(body.applicant, 'applicant', ['fullName', 'email', 'mobile', 'dateOfBirth', 'accountType', 'branch']) || {};
    var fullName = v.string(a.fullName, 'applicant.fullName', 2, 100);
    if (fullName && !NAME_RE.test(fullName)) v.fail('applicant.fullName', 'may contain only letters, spaces, apostrophes, dots and hyphens');
    var email = v.string(a.email, 'applicant.email', 1, 254);
    if (email) {
      email = email.toLowerCase();
      if (!EMAIL_RE.test(email)) v.fail('applicant.email', 'must be a valid email address');
    }
    var mobile;
    if (typeof a.mobile !== 'string') v.fail('applicant.mobile', 'is required');
    else {
      mobile = normaliseMobile(a.mobile);
      if (!/^[6-9]\d{9}$/.test(mobile)) v.fail('applicant.mobile', 'must be a valid 10-digit Indian mobile number');
    }
    var dateOfBirth;
    if (typeof a.dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(a.dateOfBirth)) v.fail('applicant.dateOfBirth', 'must be a date (YYYY-MM-DD)');
    else {
      var dob = new Date(a.dateOfBirth + 'T00:00:00Z');
      if (isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== a.dateOfBirth) v.fail('applicant.dateOfBirth', 'is not a valid date');
      else {
        var t = new Date();
        var age = t.getUTCFullYear() - dob.getUTCFullYear();
        var m = t.getUTCMonth() - dob.getUTCMonth();
        if (m < 0 || (m === 0 && t.getUTCDate() < dob.getUTCDate())) age -= 1;
        if (age < 18) v.fail('applicant.dateOfBirth', 'online account opening is available to applicants aged 18 or over; minors can apply at a branch with a guardian');
        else if (age > 120) v.fail('applicant.dateOfBirth', 'is not a valid date of birth');
        else dateOfBirth = a.dateOfBirth;
      }
    }
    var accountType = v.oneOf(a.accountType, 'applicant.accountType', bank.accountTypes.map(function (x) { return x.id; }));
    var branch = v.oneOf(a.branch, 'applicant.branch', bank.branches.map(function (x) { return x.id; }));

    var ack = v.object(body.acknowledgements, 'acknowledgements', NECESSARY) || {};
    NECESSARY.forEach(function (id) { if (ack[id] !== true) v.fail('acknowledgements.' + id, 'must be acknowledged to open an account'); });
    var consents = v.object(body.consents, 'consents', OPTIONAL) || {};
    var values = {};
    OPTIONAL.forEach(function (id) { values[id] = v.boolean(consents[id], 'consents.' + id); });
    if (typeof body.noticeVersion !== 'string') v.fail('noticeVersion', 'is required');
    v.done();
    assertVersion(body.noticeVersion, notice.version, 'NOTICE_VERSION_MISMATCH', 'privacy notice');
    return {
      applicant: { fullName: fullName, email: email, mobile: mobile, dateOfBirth: dateOfBirth, accountType: accountType, branch: branch },
      consents: values,
      noticeVersion: body.noticeVersion,
    };
  }

  function validateConsentUpdate(body) {
    var v = new Validator();
    v.object(body, '', ['consents', 'noticeVersion']);
    var out = {};
    if (body.consents && typeof body.consents === 'object' && !Array.isArray(body.consents)) {
      Object.keys(body.consents).forEach(function (k) {
        if (NECESSARY.indexOf(k) >= 0) v.fail('consents.' + k, 'is required for your account and cannot be changed here; contact the bank to close your account');
        else if (OPTIONAL.indexOf(k) < 0) v.fail('consents.' + k, 'is not a known purpose');
        else out[k] = v.boolean(body.consents[k], 'consents.' + k);
      });
      if (!Object.keys(body.consents).length) v.fail('consents', 'must include at least one purpose');
    } else v.fail('consents', 'must be an object');
    if (typeof body.noticeVersion !== 'string') v.fail('noticeVersion', 'is required');
    v.done();
    assertVersion(body.noticeVersion, notice.version, 'NOTICE_VERSION_MISMATCH', 'privacy notice');
    return { consents: out, noticeVersion: body.noticeVersion };
  }

  // ----------------------------------------------------- cookie consents
  function cookieDto(c) {
    return { id: c.id, visitorId: c.visitorId, preferences: { necessary: true, analytics: c.analytics, marketing: c.marketing }, action: c.action, policyVersion: c.policyVersion, recordedAt: c.createdAt };
  }
  function latestCookie(visitorId) {
    for (var i = db.cookies.length - 1; i >= 0; i--) if (db.cookies[i].visitorId === visitorId) return db.cookies[i];
    return null;
  }
  function recordCookieConsent(input) {
    return transaction(function () {
      var visitorId = input.visitorId || uuid();
      var latest = latestCookie(visitorId);
      if (latest && latest.analytics === input.analytics && latest.marketing === input.marketing && latest.policyVersion === input.policyVersion) {
        return { consent: cookieDto(latest), created: false };
      }
      var rec = { seq: ++db.seq.cookie, id: uuid(), visitorId: visitorId, analytics: input.analytics, marketing: input.marketing, action: input.action, policyVersion: input.policyVersion, createdAt: now() };
      db.cookies.push(rec);
      appendAudit('visitor', visitorId, latest ? 'COOKIE_CONSENT_CHANGED' : 'COOKIE_CONSENT_GIVEN', 'cookie_consent', visitorId, {
        consentId: rec.id, decision: rec.action, policyVersion: rec.policyVersion, analytics: rec.analytics, marketing: rec.marketing,
        previous: latest ? { consentId: latest.id, analytics: latest.analytics, marketing: latest.marketing, policyVersion: latest.policyVersion } : null,
      });
      return { consent: cookieDto(rec), created: true };
    });
  }
  function visitorIdFromCookie() {
    var m = document.cookie.match(new RegExp('(?:^|; )' + cookiePolicy.cookieName + '=([^;]*)'));
    if (!m) return null;
    try {
      var c = JSON.parse(decodeURIComponent(m[1]));
      return c && typeof c.vid === 'string' && UUID_RE.test(c.vid) ? c.vid.toLowerCase() : null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------- customers
  function maskEmail(email) {
    var parts = email.split('@');
    var visible = parts[0].slice(0, Math.min(2, parts[0].length));
    return visible + new Array(Math.max(parts[0].length - visible.length, 3) + 1).join('*') + '@' + parts[1];
  }
  function maskMobile(m) { return '******' + m.slice(-4); }
  function consentDto(c) {
    return { id: c.id, purpose: c.purpose, title: purposeById[c.purpose].title, legalBasis: c.legalBasis, status: c.status, noticeVersion: c.noticeVersion, source: c.source, createdAt: c.createdAt, updatedAt: c.updatedAt };
  }
  function eventDto(e) {
    return { id: e.id, purpose: e.purpose, title: purposeById[e.purpose].title, previousStatus: e.previousStatus, newStatus: e.newStatus, noticeVersion: e.noticeVersion, source: e.source, createdAt: e.createdAt };
  }
  function getConsents(customerId) {
    var order = PURPOSES.map(function (p) { return p.id; });
    return db.consents.filter(function (c) { return c.customerId === customerId; })
      .sort(function (a, b) { return order.indexOf(a.purpose) - order.indexOf(b.purpose); }).map(consentDto);
  }
  function getEvents(customerId) {
    return db.events.filter(function (e) { return e.customerId === customerId; }).reverse().map(eventDto);
  }
  function referenceId() {
    var alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var b = randomBytes(6);
    return 'BCB-' + new Date(now()).getUTCFullYear() + '-' + Array.prototype.map.call(b, function (x) { return alphabet[x % alphabet.length]; }).join('');
  }

  function createApplication(input, idempotencyKey) {
    var requestHash = sha256(JSON.stringify(input));
    return transaction(function () {
      var prev = db.idempotency[idempotencyKey];
      if (prev) {
        if (prev.requestHash !== requestHash) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
        return { status: prev.status, body: clone(prev.body), replayed: true };
      }
      var a = input.applicant;
      var dup = db.customers.some(function (c) { return c.email === a.email || c.mobile === a.mobile; });
      if (dup) {
        throw new ApiError(409, 'DUPLICATE_APPLICATION', 'An application already exists for this email address or mobile number. Please use your consent management link or contact customer support.');
      }
      var id = uuid();
      var ts = now();
      var token = randomToken();
      var ref = referenceId();
      var expires = new Date(new Date(ts).getTime() + (notice.manageTokenTtlDays || 30) * 86400000).toISOString();
      db.customers.push({
        id: id, referenceId: ref, fullName: a.fullName, email: a.email, mobile: a.mobile, dateOfBirth: a.dateOfBirth,
        accountType: a.accountType, branch: a.branch, applicationStatus: 'submitted', manageTokenHash: sha256(token),
        manageTokenExpiresAt: expires, createdAt: ts, updatedAt: ts,
      });
      appendAudit('customer', id, 'CUSTOMER_APPLICATION_SUBMITTED', 'customer', id, { referenceId: ref, accountType: a.accountType, branch: a.branch, noticeVersion: input.noticeVersion });
      PURPOSES.forEach(function (p) {
        var status = p.legalBasis === 'necessary' ? 'acknowledged' : input.consents[p.id] ? 'granted' : 'denied';
        var consentId = uuid();
        db.consents.push({ id: consentId, customerId: id, purpose: p.id, legalBasis: p.legalBasis, status: status, noticeVersion: input.noticeVersion, source: 'web_onboarding', createdAt: ts, updatedAt: ts });
        db.events.push({ id: ++db.seq.event, consentId: consentId, customerId: id, purpose: p.id, previousStatus: null, newStatus: status, noticeVersion: input.noticeVersion, source: 'web_onboarding', createdAt: ts });
        appendAudit('customer', id, 'CONSENT_RECORDED', 'customer', id, { consentId: consentId, purpose: p.id, legalBasis: p.legalBasis, status: status, noticeVersion: input.noticeVersion, source: 'web_onboarding' });
      });
      var body = {
        referenceId: ref, submittedAt: ts,
        applicant: { fullName: a.fullName, email: maskEmail(a.email), mobile: maskMobile(a.mobile), accountType: a.accountType, branch: a.branch },
        noticeVersion: input.noticeVersion, consents: getConsents(id),
        manageConsentUrl: 'manage-consent.html#token=' + token, manageConsentExpiresAt: expires,
      };
      db.idempotency[idempotencyKey] = { requestHash: requestHash, status: 201, body: body, createdAt: ts };
      return { status: 201, body: clone(body), replayed: false };
    });
  }

  function findByToken(token) {
    var c = token ? db.customers.filter(function (x) { return x.manageTokenHash === sha256(token); })[0] : null;
    if (!c || c.manageTokenExpiresAt < now()) throw new ApiError(401, 'INVALID_TOKEN', 'This consent management link is invalid or has expired.');
    return c;
  }
  function selfView(c) {
    return {
      referenceId: c.referenceId, applicant: { fullName: c.fullName, email: maskEmail(c.email), mobile: maskMobile(c.mobile) },
      currentNoticeVersion: notice.version, consents: getConsents(c.id), history: getEvents(c.id),
    };
  }
  function updateConsents(token, input) {
    return transaction(function () {
      var customer = findByToken(token);
      var ts = now();
      var changes = [];
      Object.keys(input.consents).forEach(function (purpose) {
        var cur = db.consents.filter(function (c) { return c.customerId === customer.id && c.purpose === purpose; })[0];
        var next = input.consents[purpose] ? 'granted' : cur.status === 'granted' ? 'withdrawn' : cur.status;
        if (next === cur.status) return;
        db.events.push({ id: ++db.seq.event, consentId: cur.id, customerId: customer.id, purpose: purpose, previousStatus: cur.status, newStatus: next, noticeVersion: input.noticeVersion, source: 'self_service', createdAt: ts });
        appendAudit('customer', customer.id, next === 'granted' ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN', 'customer', customer.id, { consentId: cur.id, purpose: purpose, from: cur.status, to: next, noticeVersion: input.noticeVersion, source: 'self_service' });
        changes.push({ purpose: purpose, from: cur.status, to: next });
        cur.status = next;
        cur.noticeVersion = input.noticeVersion;
        cur.source = 'self_service';
        cur.updatedAt = ts;
      });
      if (changes.length) customer.updatedAt = ts;
      var view = selfView(customer);
      view.changes = changes;
      return view;
    });
  }

  function summaryRow(c) {
    var consents = {};
    getConsents(c.id).forEach(function (x) { consents[x.purpose] = x.status; });
    return {
      id: c.id, referenceId: c.referenceId, fullName: c.fullName, email: maskEmail(c.email), mobile: maskMobile(c.mobile),
      accountType: c.accountType, branch: c.branch, applicationStatus: c.applicationStatus, createdAt: c.createdAt, updatedAt: c.updatedAt, consents: consents,
    };
  }
  function customerById(id) {
    var c = db.customers.filter(function (x) { return x.id === id; })[0];
    if (!c) throw new ApiError(404, 'NOT_FOUND', 'Customer not found');
    return c;
  }

  // -------------------------------------------------------------- stats
  function latestCookiesPerVisitor() {
    var latest = {};
    db.cookies.forEach(function (c) { latest[c.visitorId] = c; });
    return Object.keys(latest).map(function (k) { return latest[k]; }).sort(function (a, b) { return b.seq - a.seq; });
  }
  function stats() {
    var byPurpose = {};
    PURPOSES.forEach(function (p) { byPurpose[p.id] = { title: p.title, legalBasis: p.legalBasis, acknowledged: 0, granted: 0, denied: 0, withdrawn: 0 }; });
    db.consents.forEach(function (c) { byPurpose[c.purpose][c.status] += 1; });
    var latest = latestCookiesPerVisitor();
    var count = function (fn) { return latest.filter(fn).length; };
    return {
      customers: db.customers.length,
      consentRecords: db.consents.length,
      consentEvents: db.events.length,
      byPurpose: byPurpose,
      cookies: {
        visitors: latest.length,
        totalRecords: db.cookies.length,
        acceptAll: count(function (c) { return c.action === 'accept_all'; }),
        rejectOptional: count(function (c) { return c.action === 'reject_optional'; }),
        custom: count(function (c) { return c.action === 'custom'; }),
        analyticsGranted: count(function (c) { return c.analytics; }),
        marketingGranted: count(function (c) { return c.marketing; }),
        outdatedPolicy: count(function (c) { return c.policyVersion !== cookiePolicy.version; }),
      },
      telemetry: clone(db.telemetry),
      auditEntries: db.audit.length,
      policyVersions: { cookiePolicy: cookiePolicy.version, privacyNotice: notice.version },
    };
  }

  // ------------------------------------------------ proof-of-work CAPTCHA
  // Same protocol as server/lib/captcha.js: signed, purpose-bound, expiring, single-use.
  function captchaSignature(challenge) { return sha256(db.secret + '|captcha|' + challenge); }
  function createChallenge(purpose) {
    if (purpose !== 'onboarding' && purpose !== 'admin_login') throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown CAPTCHA purpose');
    var salt = randomToken().slice(0, 16) + '?purpose=' + purpose + '&expires=' + (Date.now() + 10 * 60000);
    var number = new Uint32Array(randomBytes(4).buffer)[0] % (CAPTCHA_MAX + 1);
    var challenge = sha256(salt + number);
    return { algorithm: 'SHA-256', challenge: challenge, salt: salt, maxNumber: CAPTCHA_MAX, signature: captchaSignature(challenge) };
  }
  function verifyCaptcha(raw, purpose) {
    if (!raw) throw new ApiError(403, 'CAPTCHA_REQUIRED', 'Please complete the human verification and try again.');
    var invalid = new ApiError(403, 'CAPTCHA_FAILED', 'The human verification is invalid. Please try again.');
    var p;
    try { p = JSON.parse(atob(raw)); } catch (e) { throw invalid; }
    if (!p || p.algorithm !== 'SHA-256' || typeof p.salt !== 'string' || typeof p.challenge !== 'string' || !Number.isInteger(p.number)) throw invalid;
    if (p.signature !== captchaSignature(p.challenge) || sha256(p.salt + p.number) !== p.challenge) throw invalid;
    var params = new URLSearchParams(p.salt.split('?')[1] || '');
    if (params.get('purpose') !== purpose) throw invalid;
    var expires = Number(params.get('expires'));
    if (!expires || expires < Date.now()) throw new ApiError(403, 'CAPTCHA_FAILED', 'The human verification expired. Please try again.');
    Object.keys(db.captchaUsed).forEach(function (k) { if (db.captchaUsed[k] < Date.now()) delete db.captchaUsed[k]; });
    if (db.captchaUsed[p.challenge]) throw new ApiError(403, 'CAPTCHA_FAILED', 'This human verification was already used. Please try again.');
    db.captchaUsed[p.challenge] = expires;
    save();
  }

  // --------------------------------------------------------- admin auth
  var loginFailures = 0;
  function session() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (e) { return null; }
  }
  function requireAdmin() {
    var s = session();
    if (!s || s.expiresAt < Date.now()) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to the admin dashboard');
    s.expiresAt = Date.now() + 30 * 60000;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    return s;
  }

  // ------------------------------------------------------------- routes
  var routes = [];
  function route(method, pattern, handler) { routes.push({ method: method, re: pattern, handler: handler }); }
  function ok(status, body) { return { status: status, body: body }; }

  route('GET', /^\/api\/health$/, function () { return ok(200, { status: 'ok', mode: 'static-mock', time: now() }); });
  route('GET', /^\/api\/consent-config$/, function () { return ok(200, clone(CFG.consent)); });
  route('GET', /^\/api\/captcha\/challenge$/, function (ctx) { return ok(200, createChallenge(ctx.query.get('purpose'))); });

  route('POST', /^\/api\/cookie-consents$/, function (ctx) {
    var r = recordCookieConsent(validateCookieConsent(ctx.body));
    return ok(r.created ? 201 : 200, { consent: r.consent, deduplicated: !r.created });
  });

  route('POST', /^\/api\/telemetry\/([a-z]+)$/, function (ctx) {
    var category = ctx.params[0];
    if (category !== 'analytics' && category !== 'marketing') throw new ApiError(404, 'NOT_FOUND', 'Unknown telemetry category');
    var vid = visitorIdFromCookie();
    var latest = vid ? latestCookie(vid) : null;
    if (!latest || latest.policyVersion !== cookiePolicy.version || !latest[category]) {
      throw new ApiError(403, 'CONSENT_REQUIRED', 'No valid ' + category + ' consent is recorded for this visitor');
    }
    db.telemetry[category] += 1;
    save();
    return ok(202, { accepted: true });
  });

  route('POST', /^\/api\/onboarding\/applications$/, function (ctx) {
    var key = ctx.headers['idempotency-key'];
    if (key === undefined) throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required for this request');
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 16-100 characters of letters, digits, "-" or "_"');
    var input = validateOnboarding(ctx.body);
    if (!db.idempotency[key]) verifyCaptcha(ctx.headers['x-captcha-solution'], 'onboarding');
    var r = createApplication(input, key);
    r.body.replayed = r.replayed;
    return ok(r.status, r.body);
  });

  function bearer(ctx) {
    var h = ctx.headers.authorization || '';
    return h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : null;
  }
  route('GET', /^\/api\/self\/consents$/, function (ctx) { return ok(200, selfView(findByToken(bearer(ctx)))); });
  route('PUT', /^\/api\/self\/consents$/, function (ctx) {
    var input = validateConsentUpdate(ctx.body);
    return ok(200, updateConsents(bearer(ctx), input));
  });

  route('POST', /^\/api\/admin\/login$/, function (ctx) {
    if (loginFailures >= 5) throw new ApiError(429, 'RATE_LIMITED', 'Too many failed sign-in attempts. Please wait 15 minutes.');
    var b = ctx.body || {};
    verifyCaptcha(b.captcha, 'admin_login');
    if (b.username !== CFG.admin.username || b.password !== CFG.admin.password) {
      loginFailures += 1;
      transaction(function () { appendAudit('admin', String(b.username || '').slice(0, 100), 'ADMIN_LOGIN_FAILED', 'admin_session', null, {}); });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
    }
    loginFailures = 0;
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ username: b.username, expiresAt: Date.now() + 30 * 60000 })); } catch (e) { /* ignore */ }
    transaction(function () { appendAudit('admin', b.username, 'ADMIN_LOGIN', 'admin_session', null, {}); });
    return ok(200, { username: b.username });
  });
  route('POST', /^\/api\/admin\/logout$/, function () {
    var s = session();
    try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    if (s) transaction(function () { appendAudit('admin', s.username, 'ADMIN_LOGOUT', 'admin_session', null, {}); });
    return ok(200, { ok: true });
  });
  route('GET', /^\/api\/admin\/me$/, function () { return ok(200, { username: requireAdmin().username, usingDevPassword: false }); });
  route('GET', /^\/api\/admin\/stats$/, function () { requireAdmin(); return ok(200, stats()); });

  route('GET', /^\/api\/admin\/customers$/, function (ctx) {
    requireAdmin();
    var q = (ctx.query.get('q') || '').trim().slice(0, 100);
    var purpose = ctx.query.get('purpose');
    var status = ctx.query.get('status');
    var list = db.customers.slice().reverse();
    if (q) {
      var digits = q.replace(/[\s+()-]/g, '').replace(/^91(?=\d{10}$)/, '');
      if (q.indexOf('@') >= 0) list = list.filter(function (c) { return c.email === q.toLowerCase(); });
      else if (/^[6-9]\d{9}$/.test(digits)) list = list.filter(function (c) { return c.mobile === digits; });
      else if (/^BCB-/i.test(q)) list = list.filter(function (c) { return c.referenceId.indexOf(q.toUpperCase()) === 0; });
      else list = list.filter(function (c) { return c.fullName.toLowerCase().indexOf(q.toLowerCase()) >= 0; });
    }
    if (purpose || status) {
      list = list.filter(function (c) {
        return db.consents.some(function (x) { return x.customerId === c.id && (!purpose || x.purpose === purpose) && (!status || x.status === status); });
      });
    }
    return ok(200, { customers: list.map(summaryRow) });
  });
  route('GET', /^\/api\/admin\/customers\/([^/]+)$/, function (ctx) {
    requireAdmin();
    var c = customerById(ctx.params[0]);
    var row = summaryRow(c);
    row.dateOfBirth = '****-**-**';
    row.consentRecords = getConsents(c.id);
    row.history = getEvents(c.id);
    row.manageTokenExpiresAt = c.manageTokenExpiresAt;
    return ok(200, { customer: row, audit: listAudit({ entityType: 'customer', entityId: c.id }) });
  });
  route('POST', /^\/api\/admin\/customers\/([^/]+)\/reveal$/, function (ctx) {
    var s = requireAdmin();
    var v = new Validator();
    v.object(ctx.body, '', ['reason']);
    var reason = v.string((ctx.body || {}).reason, 'reason', 5, 200);
    v.done();
    var c = customerById(ctx.params[0]);
    transaction(function () {
      appendAudit('admin', s.username, 'PII_REVEALED', 'customer', c.id, { referenceId: c.referenceId, reason: reason, fields: ['fullName', 'email', 'mobile', 'dateOfBirth'] });
    });
    return ok(200, { pii: { fullName: c.fullName, email: c.email, mobile: c.mobile, dateOfBirth: c.dateOfBirth } });
  });

  route('GET', /^\/api\/admin\/cookie-consents$/, function (ctx) {
    requireAdmin();
    var action = ctx.query.get('action');
    var category = ctx.query.get('category');
    var visitor = (ctx.query.get('visitor') || '').toLowerCase().replace(/[^0-9a-f-]/g, '');
    var rows = ctx.query.get('history') === 'all' ? db.cookies.slice().reverse() : latestCookiesPerVisitor();
    rows = rows.filter(function (c) {
      if (action && c.action !== action) return false;
      if (category === 'analytics' && !c.analytics) return false;
      if (category === 'marketing' && !c.marketing) return false;
      if (category === 'none' && (c.analytics || c.marketing)) return false;
      if (visitor && c.visitorId.indexOf(visitor) !== 0) return false;
      return true;
    });
    return ok(200, {
      consents: rows.map(function (c) {
        var d = cookieDto(c);
        d.historyCount = db.cookies.filter(function (x) { return x.visitorId === c.visitorId; }).length;
        d.isCurrentPolicy = c.policyVersion === cookiePolicy.version;
        return d;
      }),
    });
  });
  route('GET', /^\/api\/admin\/cookie-consents\/visitors\/([^/]+)$/, function (ctx) {
    requireAdmin();
    var vid = ctx.params[0].toLowerCase();
    if (!UUID_RE.test(vid)) throw new ApiError(422, 'VALIDATION_FAILED', 'visitorId must be a UUID');
    return ok(200, {
      visitorId: vid,
      history: db.cookies.filter(function (c) { return c.visitorId === vid; }).reverse().map(cookieDto),
      audit: listAudit({ entityType: 'cookie_consent', entityId: vid }),
    });
  });
  route('GET', /^\/api\/admin\/audit$/, function (ctx) {
    requireAdmin();
    var actions = {};
    db.audit.forEach(function (e) { actions[e.action] = true; });
    return ok(200, {
      entries: listAudit({ action: ctx.query.get('action'), entityType: ctx.query.get('entityType'), limit: Math.min(parseInt(ctx.query.get('limit') || '200', 10) || 200, 500) }),
      actions: Object.keys(actions).sort(),
    });
  });
  route('GET', /^\/api\/admin\/audit\/verify$/, function () { requireAdmin(); return ok(200, verifyChain()); });
  route('GET', /^\/api\/admin\/policies$/, function () { requireAdmin(); return ok(200, { policies: clone(db.policies).reverse() }); });

  // ------------------------------------------------------- fetch shim
  function headersOf(init) {
    var out = {};
    var h = init && init.headers;
    if (!h) return out;
    if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach(function (v, k) { out[k.toLowerCase()] = v; });
    else Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
    return out;
  }

  function handle(method, url, init) {
    var idx = url.pathname.indexOf('/api/');
    var path = url.pathname.slice(idx).replace(/\/$/, '');
    var allowed = [];
    for (var i = 0; i < routes.length; i++) {
      var m = routes[i].re.exec(path);
      if (!m) continue;
      if (routes[i].method !== method) { allowed.push(routes[i].method); continue; }
      var body = null;
      if (init && typeof init.body === 'string' && init.body) {
        try { body = JSON.parse(init.body); } catch (e) { throw new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'INVALID_BODY', 'Request body must be a JSON object');
      } else if (method === 'POST' || method === 'PUT') {
        body = {};
      }
      var params = Array.prototype.slice.call(m, 1).map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
      return routes[i].handler({ method: method, path: path, query: url.searchParams, headers: headersOf(init), body: body, params: params });
    }
    if (allowed.length) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') < 0) return realFetch(input, init);
    var method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    return new Promise(function (resolve) {
      setTimeout(function () {
        var result;
        try {
          result = handle(method, url, init);
        } catch (err) {
          if (!(err instanceof ApiError)) {
            console.error('[mock API]', err);
            err = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
          }
          var payload = { code: err.code, message: err.message };
          if (err.details) payload.details = err.details;
          result = { status: err.status, body: { error: payload } };
        }
        resolve(new Response(JSON.stringify(result.body), { status: result.status, headers: { 'Content-Type': 'application/json' } }));
      }, 120);
    });
  };

  // --------------------------------------------------------------- seed
  function seed() {
    db = emptyDb();
    var t = Date.now() - 3 * 86400000;
    function tick(minutes) { t += minutes * 60000; clock = new Date(t); }
    tick(0);
    [['cookie_policy', cookiePolicy.version, cookiePolicy.effectiveFrom, cookiePolicy.categories],
      ['privacy_notice', notice.version, notice.effectiveFrom, notice.purposes]].forEach(function (p) {
      var hash = sha256(JSON.stringify(p[3]));
      db.policies.push({ policyType: p[0], version: p[1], contentHash: hash, effectiveFrom: p[2], registeredAt: now() });
      appendAudit('system', null, 'POLICY_VERSION_PUBLISHED', 'policy', p[0] + '@' + p[1], { contentHash: hash, effectiveFrom: p[2] });
    });

    var people = [
      ['Aarav Kumar', 'aarav.kumar@example.com', '9876500001', '1990-04-12', 'savings', 'patna_main', true, false, null],
      ['Priya Sinha', 'priya.sinha@example.com', '9876500002', '1985-11-03', 'fixed_deposit', 'gaya', false, false, null],
      ['Rohan Mishra', 'rohan.mishra@example.com', '9876500003', '1998-01-25', 'savings', 'muzaffarpur', true, true, { marketing_communications: false }],
      ['Sneha Jha', 'sneha.jha@example.com', '9876500004', '1979-07-19', 'current', 'bhagalpur', false, false, { marketing_communications: true }],
      ['Vikram Singh', 'vikram.singh@example.com', '9876500005', '1969-02-08', 'recurring_deposit', 'darbhanga', true, false, null],
      ['Ananya Choudhary', 'ananya.choudhary@example.com', '9876500006', '2001-09-30', 'savings', 'purnia', false, true, { third_party_sharing: false }],
      ['Mohammad Imran', 'm.imran@example.com', '9876500007', '1992-12-14', 'current', 'patna_kankarbagh', false, false, null],
      ['Kavita Devi', 'kavita.devi@example.com', '9876500008', '1975-05-21', 'fixed_deposit', 'patna_main', true, true, null],
    ];
    var decisions = [
      ['accept_all', true, true], ['reject_optional', false, false], ['accept_all', true, true], ['custom', true, false],
      ['reject_optional', false, false], ['custom', false, true], ['accept_all', true, true], ['reject_optional', false, false],
      ['custom', true, false], ['accept_all', true, true],
    ];

    decisions.forEach(function (d, i) {
      tick(25 + i * 17);
      var vid = uuid();
      recordCookieConsent({ visitorId: vid, analytics: d[1], marketing: d[2], action: d[0], policyVersion: cookiePolicy.version });
      if (d[1]) db.telemetry.analytics += 3;
      if (d[2]) db.telemetry.marketing += 2;
      if (i % 4 === 0) {
        tick(90);
        recordCookieConsent({ visitorId: vid, analytics: true, marketing: false, action: 'custom', policyVersion: cookiePolicy.version });
      }
      var p = people[i];
      if (!p) return;
      tick(12);
      var r = createApplication({
        applicant: { fullName: p[0], email: p[1], mobile: p[2], dateOfBirth: p[3], accountType: p[4], branch: p[5] },
        consents: { marketing_communications: p[6], third_party_sharing: p[7] },
        noticeVersion: notice.version,
      }, 'seed-' + sha256(p[1]).slice(0, 24));
      if (p[8]) {
        tick(300 + i * 40);
        updateConsents(r.body.manageConsentUrl.split('#token=')[1], { consents: p[8], noticeVersion: notice.version });
      }
    });
    db.idempotency = {};
    clock = null;
    save();
  }

  var db = load();
  if (!db) seed();
  db.captchaUsed = db.captchaUsed || {};

  window.DemoMock = {
    reset: function () { seed(); },
    verifyChain: verifyChain,
  };

  // ------------------------------------------- static-demo UI additions
  document.addEventListener('DOMContentLoaded', function () {
    var strip = document.querySelector('.demo-strip');
    if (strip) strip.appendChild(document.createTextNode(' Static GitHub Pages demo: the API runs in your browser and data is stored only on this device.'));

    var hint = document.getElementById('login-hint');
    if (hint) hint.textContent = 'Demo credentials: ' + CFG.admin.username + ' / ' + CFG.admin.password;

    var userBar = document.querySelector('.pv-user');
    if (userBar) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = 'Reset demo data';
      btn.addEventListener('click', function () {
        if (!window.confirm('Reset all demo data in this browser to the original sample data?')) return;
        seed();
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
        // Forget this browser's cookie choice too, so the banner appears again.
        [cookiePolicy.cookieName].concat(cookiePolicy.categories.reduce(function (all, c) {
          return all.concat(c.required ? [] : c.cookies.map(function (k) { return k.name; }));
        }, [])).forEach(function (name) { document.cookie = name + '=; Max-Age=0; Path=/'; });
        location.reload();
      });
      userBar.insertBefore(btn, userBar.firstChild);
    }
  });
})();
