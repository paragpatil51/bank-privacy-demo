'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-test-'));
Object.assign(process.env, {
  DATA_DIR: tmp,
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'Test-Password-123',
  PII_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
  PII_HMAC_KEY: crypto.randomBytes(32).toString('base64'),
  RATE_LIMIT_API: '100000',
  RATE_LIMIT_COOKIE: '100000',
  RATE_LIMIT_ONBOARDING: '100000',
  RATE_LIMIT_SELF_SERVICE: '100000',
  LOG_REQUESTS: 'false',
});

const config = require('../server/config');
const { createApp } = require('../server/app');

let server;
let db;
let base;

before(async () => {
  ({ server, db } = createApp());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* Windows may hold the file briefly */ }
});

/** Solves a proof-of-work CAPTCHA exactly like the browser does. */
async function solveCaptcha(purpose) {
  const res = await fetch(`${base}/api/captcha/challenge?purpose=${purpose}`);
  const ch = await res.json();
  for (let n = 0; n <= ch.maxNumber; n += 1) {
    if (crypto.createHash('sha256').update(ch.salt + n).digest('hex') === ch.challenge) {
      return Buffer.from(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, number: n, salt: ch.salt, signature: ch.signature })).toString('base64');
    }
  }
  throw new Error('unsolvable challenge');
}

// Protected endpoints get a freshly solved CAPTCHA automatically unless captcha: false.
async function call(method, p, { body, headers = {}, cookie, captcha = true } = {}) {
  if (captcha && method === 'POST' && p === '/api/onboarding/applications' && !('X-Captcha-Solution' in headers)) {
    headers = { ...headers, 'X-Captcha-Solution': await solveCaptcha('onboarding') };
  }
  if (captcha && method === 'POST' && p === '/api/admin/login' && body && !('captcha' in body)) {
    body = { ...body, captcha: await solveCaptcha('admin_login') };
  }
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, json, text };
}

let counter = 0;
function application(overrides = {}) {
  counter += 1;
  const n = String(counter).padStart(4, '0');
  return {
    applicant: {
      fullName: 'Test Applicant',
      email: `applicant${n}@example.com`,
      mobile: `98765${n}0`.slice(0, 10),
      dateOfBirth: '1990-01-15',
      accountType: 'savings',
      branch: 'patna_main',
      ...(overrides.applicant || {}),
    },
    acknowledgements: { account_opening: true, ...(overrides.acknowledgements || {}) },
    consents: { marketing_communications: false, third_party_sharing: false, ...(overrides.consents || {}) },
    noticeVersion: overrides.noticeVersion || config.privacyNotice.version,
  };
}
const key = () => crypto.randomUUID();

function consentCookie(consent) {
  return `bcb_consent=${encodeURIComponent(JSON.stringify({ v: consent.policyVersion, id: consent.id, vid: consent.visitorId, a: consent.preferences.analytics ? 1 : 0, m: consent.preferences.marketing ? 1 : 0, ts: consent.recordedAt }))}`;
}

describe('website', () => {
  test('pages are served with strict security headers', async () => {
    for (const page of ['/', '/about.html', '/contact.html', '/support.html', '/open-account.html', '/privacy-policy.html', '/cookie-policy.html', '/manage-consent.html', '/admin/']) {
      const r = await call('GET', page);
      assert.equal(r.status, 200, page);
      const csp = r.headers.get('content-security-policy');
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-inline/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.doesNotMatch(r.text, /<!--#include|\{\{[A-Z_]+\}\}/, `${page} has unrendered template markers`);
    }
  });

  test('every page links the privacy and cookie policies', async () => {
    const r = await call('GET', '/');
    assert.match(r.text, /href="\/privacy-policy.html"/);
    assert.match(r.text, /href="\/cookie-policy.html"/);
  });

  test('optional scripts are blocked in the HTML until consent', async () => {
    const r = await call('GET', '/');
    const scripts = [...r.text.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    const optional = scripts.filter((s) => /demo-(analytics|marketing)/.test(s));
    assert.equal(optional.length, 2);
    for (const s of optional) {
      assert.match(s, /type="text\/plain"/);
      assert.doesNotMatch(s, /\ssrc=/, 'blocked scripts must not have an executable src attribute');
    }
    // No inline executable scripts (CSP would block them anyway).
    for (const m of r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (m[2].trim()) assert.match(m[1], /type="(application\/json|text\/plain)"/);
    }
  });

  test('path traversal, partials and Windows path tricks are not served', async () => {
    for (const p of ['/../server/config.js', '/%2e%2e/package.json', '/partials/footer.html', '/..%5c..%5cpackage.json', '/index.html::$DATA', '/C:/Windows/win.ini', '/.gitignore']) {
      const r = await call('GET', p);
      assert.equal(r.status, 404, p);
    }
  });

  test('CSP enforces Trusted Types and blocks framing', async () => {
    const r = await call('GET', '/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /require-trusted-types-for 'script'/);
    assert.match(csp, /trusted-types bcb-cmp/);
    assert.match(csp, /frame-ancestors 'none'/);
  });

  test('requests for unknown hostnames are rejected (DNS rebinding)', async () => {
    const http = require('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request(`${base}/api/health`, { headers: { Host: 'attacker.example:3000' } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 421);
  });
});

describe('cookie consent API', () => {
  const policyVersion = config.cookiePolicy.version;

  test('records accept all, then de-duplicates the same choice', async () => {
    const body = { preferences: { necessary: true, analytics: true, marketing: true }, action: 'accept_all', policyVersion };
    const first = await call('POST', '/api/cookie-consents', { body });
    assert.equal(first.status, 201);
    assert.equal(first.json.consent.policyVersion, policyVersion);
    assert.ok(first.json.consent.recordedAt);
    const again = await call('POST', '/api/cookie-consents', { body: { ...body, visitorId: first.json.consent.visitorId } });
    assert.equal(again.status, 200);
    assert.equal(again.json.deduplicated, true);
    assert.equal(again.json.consent.id, first.json.consent.id);
  });

  test('rejects inconsistent or invalid decisions', async () => {
    const cases = [
      { preferences: { analytics: true, marketing: false }, action: 'accept_all', policyVersion },
      { preferences: { analytics: true, marketing: false }, action: 'reject_optional', policyVersion },
      { preferences: { necessary: false, analytics: false, marketing: false }, action: 'reject_optional', policyVersion },
      { preferences: { analytics: 'yes', marketing: false }, action: 'custom', policyVersion },
      { preferences: { analytics: false }, action: 'custom', policyVersion },
      { preferences: { analytics: false, marketing: false }, action: 'custom', policyVersion, extra: 1 },
      { visitorId: 'not-a-uuid', preferences: { analytics: false, marketing: false }, action: 'custom', policyVersion },
    ];
    for (const body of cases) {
      const r = await call('POST', '/api/cookie-consents', { body });
      assert.equal(r.status, 422, JSON.stringify(body));
    }
  });

  test('rejects a stale policy version', async () => {
    const r = await call('POST', '/api/cookie-consents', { body: { preferences: { analytics: false, marketing: false }, action: 'reject_optional', policyVersion: '0.9' } });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'POLICY_VERSION_MISMATCH');
  });

  test('server refuses analytics/marketing events without consent', async () => {
    const event = { event: 'page_view', path: '/' };
    assert.equal((await call('POST', '/api/telemetry/analytics', { body: event })).status, 403);

    const rejected = await call('POST', '/api/cookie-consents', { body: { preferences: { analytics: false, marketing: false }, action: 'reject_optional', policyVersion } });
    assert.equal((await call('POST', '/api/telemetry/analytics', { body: event, cookie: consentCookie(rejected.json.consent) })).status, 403);

    const custom = await call('POST', '/api/cookie-consents', { body: { visitorId: rejected.json.consent.visitorId, preferences: { analytics: true, marketing: false }, action: 'custom', policyVersion } });
    assert.equal(custom.status, 201);
    const cookie = consentCookie(custom.json.consent);
    assert.equal((await call('POST', '/api/telemetry/analytics', { body: event, cookie })).status, 202);
    assert.equal((await call('POST', '/api/telemetry/marketing', { body: event, cookie })).status, 403);

    // A forged cookie claiming marketing consent is still refused: the server checks its own records.
    const forged = consentCookie({ ...custom.json.consent, preferences: { analytics: true, marketing: true } });
    assert.equal((await call('POST', '/api/telemetry/marketing', { body: event, cookie: forged })).status, 403);

    // After withdrawal, analytics is refused again.
    const withdrawn = await call('POST', '/api/cookie-consents', { body: { visitorId: custom.json.consent.visitorId, preferences: { analytics: false, marketing: false }, action: 'reject_optional', policyVersion } });
    assert.equal((await call('POST', '/api/telemetry/analytics', { body: event, cookie: consentCookie(withdrawn.json.consent) })).status, 403);
  });

  test('cross-origin writes are blocked', async () => {
    const r = await call('POST', '/api/cookie-consents', {
      headers: { Origin: 'https://evil.example' },
      body: { preferences: { analytics: true, marketing: true }, action: 'accept_all', policyVersion },
    });
    assert.equal(r.status, 403);
  });

  test('requires JSON content type', async () => {
    const res = await fetch(`${base}/api/cookie-consents`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415);
  });
});

describe('onboarding consent API', () => {
  test('creates an application with separate, per-purpose consent records', async () => {
    const r = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: application({ consents: { marketing_communications: true } }) });
    assert.equal(r.status, 201);
    assert.match(r.json.referenceId, /^BCB-\d{4}-[A-Z0-9]{6}$/);
    const byPurpose = Object.fromEntries(r.json.consents.map((c) => [c.purpose, c]));
    assert.equal(byPurpose.account_opening.status, 'acknowledged');
    assert.equal(byPurpose.account_opening.legalBasis, 'necessary');
    assert.equal(byPurpose.marketing_communications.status, 'granted');
    assert.equal(byPurpose.third_party_sharing.status, 'denied');
    for (const c of r.json.consents) {
      assert.equal(c.noticeVersion, config.privacyNotice.version);
      assert.ok(c.createdAt);
    }
    assert.match(r.json.applicant.email, /\*/, 'email must be masked in the response');
    assert.match(r.json.manageConsentUrl, /^\/manage-consent\.html#token=/);
  });

  test('marketing is not required and cannot be implied', async () => {
    const ok = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: application() });
    assert.equal(ok.status, 201, 'onboarding must succeed with marketing declined');
    const body = application();
    delete body.consents.marketing_communications;
    const missing = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body });
    assert.equal(missing.status, 422);
    assert.ok(missing.json.error.details.some((d) => d.field === 'consents.marketing_communications'));
  });

  test('necessary acknowledgement is required', async () => {
    const r = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: application({ acknowledgements: { account_opening: false } }) });
    assert.equal(r.status, 422);
    assert.ok(r.json.error.details.some((d) => d.field === 'acknowledgements.account_opening'));
  });

  test('validates applicant fields', async () => {
    const bad = [
      { fullName: 'X' }, { fullName: '<script>alert(1)</script>' }, { email: 'not-an-email' }, { mobile: '12345' },
      { mobile: '5876543210' }, { dateOfBirth: '2015-01-01' }, { dateOfBirth: '1990-02-30' }, { accountType: 'crypto' }, { branch: 'mumbai' },
    ];
    for (const applicant of bad) {
      const r = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: application({ applicant }) });
      assert.equal(r.status, 422, JSON.stringify(applicant));
    }
  });

  test('rejects consent given against an outdated notice', async () => {
    const r = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: application({ noticeVersion: '2020.1' }) });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'NOTICE_VERSION_MISMATCH');
  });

  test('idempotency: retries replay, key reuse with a different body is rejected', async () => {
    const k = key();
    const body = application();
    const first = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': k }, body });
    const second = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': k }, body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(second.json.replayed, true);
    assert.equal(second.json.referenceId, first.json.referenceId);
    const count = db.prepare('SELECT COUNT(*) AS n FROM customer_consents WHERE customer_id = (SELECT id FROM customers WHERE reference_id = ?)').get(first.json.referenceId).n;
    assert.equal(count, 3, 'replay must not create extra consent rows');

    // A network retry of a processed request replays without needing a new CAPTCHA.
    const retry = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': k }, body, captcha: false });
    assert.equal(retry.status, 201);
    assert.equal(retry.json.referenceId, first.json.referenceId);

    const reuse = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': k }, body: application() });
    assert.equal(reuse.status, 422);
    assert.equal(reuse.json.error.code, 'IDEMPOTENCY_KEY_REUSED');

    const noKey = await call('POST', '/api/onboarding/applications', { body: application() });
    assert.equal(noKey.status, 400);
  });

  test('duplicate applications (same email or mobile) are rejected', async () => {
    const body = application();
    assert.equal((await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body })).status, 201);
    const sameEmail = application({ applicant: { email: body.applicant.email.toUpperCase() } });
    const r1 = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: sameEmail });
    assert.equal(r1.status, 409);
    assert.equal(r1.json.error.code, 'DUPLICATE_APPLICATION');
    const sameMobile = application({ applicant: { mobile: `+91 ${body.applicant.mobile}` } });
    assert.equal((await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: sameMobile })).status, 409);
  });

  test('personal data is encrypted at rest', async () => {
    const body = application({ applicant: { fullName: 'Plaintext Checker', email: 'plaintext.checker@example.com' } });
    await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body });
    const dump = JSON.stringify(db.prepare('SELECT * FROM customers').all()) + JSON.stringify(db.prepare('SELECT * FROM audit_log').all()) + JSON.stringify(db.prepare('SELECT * FROM idempotency_keys').all());
    assert.ok(!dump.includes('plaintext.checker@example.com'));
    assert.ok(!dump.includes('Plaintext Checker'));
    assert.ok(!dump.includes(body.applicant.mobile));
  });
});

describe('proof-of-work CAPTCHA', () => {
  const submit = (solution) => call('POST', '/api/onboarding/applications', {
    headers: { 'Idempotency-Key': key(), ...(solution === undefined ? {} : { 'X-Captcha-Solution': solution }) },
    body: application(),
    captcha: false,
  });

  test('onboarding without a CAPTCHA is refused', async () => {
    const r = await submit();
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'CAPTCHA_REQUIRED');
  });

  test('a solution can be used only once', async () => {
    const solution = await solveCaptcha('onboarding');
    assert.equal((await submit(solution)).status, 201);
    const again = await submit(solution);
    assert.equal(again.status, 403);
    assert.equal(again.json.error.code, 'CAPTCHA_FAILED');
  });

  test('a solution for another purpose is refused', async () => {
    const r = await submit(await solveCaptcha('admin_login'));
    assert.equal(r.status, 403);
  });

  test('tampered or forged solutions are refused', async () => {
    const valid = JSON.parse(Buffer.from(await solveCaptcha('onboarding'), 'base64').toString());
    const wrongNumber = Buffer.from(JSON.stringify({ ...valid, number: (valid.number + 1) % 50000 })).toString('base64');
    assert.equal((await submit(wrongNumber)).status, 403);
    // Attacker builds their own easy challenge but cannot sign it.
    const salt = 'x?purpose=onboarding&expires=9999999999999';
    const forged = { algorithm: 'SHA-256', salt, number: 1, challenge: crypto.createHash('sha256').update(`${salt}1`).digest('hex'), signature: 'f'.repeat(64) };
    assert.equal((await submit(Buffer.from(JSON.stringify(forged)).toString('base64'))).status, 403);
    assert.equal((await submit('not-base64-json')).status, 403);
  });

  test('admin login requires a CAPTCHA', async () => {
    const r = await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'Test-Password-123' }, captcha: false });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'CAPTCHA_REQUIRED');
  });
});

describe('customer self-service', () => {
  let token;
  before(async () => {
    const r = await call('POST', '/api/onboarding/applications', { headers: { 'Idempotency-Key': key() }, body: application({ consents: { marketing_communications: true } }) });
    token = r.json.manageConsentUrl.split('#token=')[1];
  });

  test('requires a valid token', async () => {
    assert.equal((await call('GET', '/api/self/consents')).status, 401);
    assert.equal((await call('GET', '/api/self/consents', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401);
  });

  test('withdraws and re-grants consent with history; no-op saves add nothing', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const withdraw = await call('PUT', '/api/self/consents', { headers: auth, body: { consents: { marketing_communications: false }, noticeVersion: config.privacyNotice.version } });
    assert.equal(withdraw.status, 200);
    assert.deepEqual(withdraw.json.changes, [{ purpose: 'marketing_communications', from: 'granted', to: 'withdrawn' }]);

    const noop = await call('PUT', '/api/self/consents', { headers: auth, body: { consents: { marketing_communications: false, third_party_sharing: false }, noticeVersion: config.privacyNotice.version } });
    assert.deepEqual(noop.json.changes, []);

    const regrant = await call('PUT', '/api/self/consents', { headers: auth, body: { consents: { marketing_communications: true }, noticeVersion: config.privacyNotice.version } });
    assert.equal(regrant.json.changes[0].to, 'granted');
    const marketingEvents = regrant.json.history.filter((e) => e.purpose === 'marketing_communications');
    assert.deepEqual(marketingEvents.map((e) => e.newStatus), ['granted', 'withdrawn', 'granted']);
  });

  test('cannot change necessary processing or unknown purposes', async () => {
    const auth = { Authorization: `Bearer ${token}` };
    const r1 = await call('PUT', '/api/self/consents', { headers: auth, body: { consents: { account_opening: false }, noticeVersion: config.privacyNotice.version } });
    assert.equal(r1.status, 422);
    const r2 = await call('PUT', '/api/self/consents', { headers: auth, body: { consents: { profiling: true }, noticeVersion: config.privacyNotice.version } });
    assert.equal(r2.status, 422);
  });
});

describe('admin dashboard API', () => {
  let cookie;

  test('requires authentication', async () => {
    for (const p of ['/api/admin/stats', '/api/admin/customers', '/api/admin/cookie-consents', '/api/admin/audit']) {
      assert.equal((await call('GET', p)).status, 401, p);
    }
  });

  test('rejects wrong credentials and issues a secure session cookie', async () => {
    assert.equal((await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong' } })).status, 401);
    const r = await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'Test-Password-123' } });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    cookie = setCookie.split(';')[0];
  });

  test('shows counts, customers (masked) and filters', async () => {
    const stats = await call('GET', '/api/admin/stats', { cookie });
    assert.equal(stats.status, 200);
    assert.ok(stats.json.customers > 0);
    assert.ok(stats.json.byPurpose.marketing_communications.granted >= 1);
    assert.ok(stats.json.cookies.visitors >= 1);

    const list = await call('GET', '/api/admin/customers', { cookie });
    assert.ok(list.json.customers.length > 0);
    for (const c of list.json.customers) {
      assert.match(c.email, /\*/);
      assert.match(c.mobile, /^\*{6}\d{4}$/);
    }

    const granted = await call('GET', '/api/admin/customers?purpose=marketing_communications&status=granted', { cookie });
    assert.ok(granted.json.customers.every((c) => c.consents.marketing_communications === 'granted'));

    const byEmail = await call('GET', '/api/admin/customers?q=plaintext.checker@example.com', { cookie });
    assert.equal(byEmail.json.customers.length, 1);
    const byName = await call('GET', '/api/admin/customers?q=plaintext', { cookie });
    assert.equal(byName.json.customers.length, 1);

    const detail = await call('GET', `/api/admin/customers/${byEmail.json.customers[0].id}`, { cookie });
    assert.equal(detail.status, 200);
    assert.ok(detail.json.customer.history.length >= 3);
    assert.ok(detail.json.audit.some((a) => a.action === 'CONSENT_RECORDED'));
  });

  test('revealing PII requires a reason and is audited', async () => {
    const list = await call('GET', '/api/admin/customers?q=plaintext.checker@example.com', { cookie });
    const id = list.json.customers[0].id;
    assert.equal((await call('POST', `/api/admin/customers/${id}/reveal`, { cookie, body: {} })).status, 422);
    const r = await call('POST', `/api/admin/customers/${id}/reveal`, { cookie, body: { reason: 'Identity verification call' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.pii.email, 'plaintext.checker@example.com');
    const audit = await call('GET', '/api/admin/audit?action=PII_REVEALED', { cookie });
    assert.ok(audit.json.entries.some((e) => e.entityId === id && e.details.reason === 'Identity verification call'));
  });

  test('cookie consent records and visitor history', async () => {
    const latest = await call('GET', '/api/admin/cookie-consents', { cookie });
    assert.ok(latest.json.consents.length > 0);
    const visitorIds = latest.json.consents.map((c) => c.visitorId);
    assert.equal(new Set(visitorIds).size, visitorIds.length, 'latest view has one row per visitor');
    const changed = latest.json.consents.find((c) => c.historyCount > 1);
    const history = await call('GET', `/api/admin/cookie-consents/visitors/${changed.visitorId}`, { cookie });
    assert.ok(history.json.history.length > 1);
    assert.ok(history.json.audit.some((a) => a.action === 'COOKIE_CONSENT_CHANGED'));
    const rejected = await call('GET', '/api/admin/cookie-consents?action=reject_optional', { cookie });
    assert.ok(rejected.json.consents.every((c) => c.action === 'reject_optional'));
  });

  test('audit trail is append-only and tamper-evident', async () => {
    const verify = await call('GET', '/api/admin/audit/verify', { cookie });
    assert.equal(verify.json.valid, true);
    assert.ok(verify.json.checked > 5);
    assert.throws(() => db.prepare("UPDATE audit_log SET action = 'X' WHERE id = 1").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id = 1').run(), /append-only/);
    assert.throws(() => db.prepare("UPDATE consent_events SET new_status = 'granted' WHERE id = 1").run(), /append-only/);

    // Simulate an attacker with DB access who removes the trigger and edits history.
    db.exec('DROP TRIGGER audit_log_no_update');
    db.prepare("UPDATE audit_log SET details = '{}' WHERE id = 2").run();
    const tampered = await call('GET', '/api/admin/audit/verify', { cookie });
    assert.equal(tampered.json.valid, false);
    assert.equal(tampered.json.brokenAtId, 2);
  });

  test('logout ends the session', async () => {
    await call('POST', '/api/admin/logout', { cookie, body: {} });
    assert.equal((await call('GET', '/api/admin/stats', { cookie })).status, 401);
  });
});
