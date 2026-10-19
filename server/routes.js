'use strict';

const config = require('./config');
const { ApiError, sendJson, readJson, createRateLimiter } = require('./lib/http');
const v = require('./lib/validation');
const cookieConsents = require('./services/cookieConsents');
const customers = require('./services/customers');
const audit = require('./services/audit');
const admin = require('./services/admin');
const captcha = require('./lib/captcha');

function publicConsentConfig() {
  return {
    cookiePolicy: {
      version: config.cookiePolicy.version,
      effectiveFrom: config.cookiePolicy.effectiveFrom,
      consentMaxAgeDays: config.cookiePolicy.consentMaxAgeDays,
      cookieName: config.cookiePolicy.cookieName,
      categories: config.cookiePolicy.categories,
    },
    privacyNotice: {
      version: config.privacyNotice.version,
      effectiveFrom: config.privacyNotice.effectiveFrom,
      purposes: config.privacyNotice.purposes,
    },
    bank: config.bank,
  };
}

function visitorIdFromCookie(cookies) {
  try {
    const parsed = JSON.parse(cookies[config.cookiePolicy.cookieName] || 'null');
    return parsed && typeof parsed.vid === 'string' && v.UUID_RE.test(parsed.vid) ? parsed.vid.toLowerCase() : null;
  } catch {
    return null;
  }
}

function registerRoutes(router, { db }) {
  const auth = admin.createAdminAuth(db);
  const limits = {
    cookie: createRateLimiter(config.rateLimits.cookieConsent),
    onboarding: createRateLimiter(config.rateLimits.onboarding),
    selfService: createRateLimiter(config.rateLimits.selfService),
    loginFailures: createRateLimiter(config.rateLimits.loginFailures),
  };

  // ------------------------------------------------------------- public API
  router.get('/api/health', ({ res }) => sendJson(res, 200, { status: 'ok', time: new Date().toISOString() }));

  router.get('/api/consent-config', ({ res }) => sendJson(res, 200, publicConsentConfig()));

  router.post('/api/cookie-consents', async ({ req, res, ip }) => {
    limits.cookie.consume(ip);
    const input = v.validateCookieConsent(await readJson(req));
    const result = cookieConsents.recordCookieConsent(db, input, { ip, userAgent: req.headers['user-agent'] });
    sendJson(res, result.created ? 201 : 200, { consent: result.consent, deduplicated: !result.created });
  });

  // Endpoint used by the demo analytics / marketing scripts. The server checks
  // the recorded consent itself, so even a script that bypasses the banner
  // cannot store data without a valid consent record.
  router.post('/api/telemetry/:category', async ({ req, res, params, cookies }) => {
    if (!['analytics', 'marketing'].includes(params.category)) throw new ApiError(404, 'NOT_FOUND', 'Unknown telemetry category');
    const input = v.validateTelemetry(await readJson(req));
    cookieConsents.recordTelemetry(db, { category: params.category, visitorId: visitorIdFromCookie(cookies), path: input.path });
    sendJson(res, 202, { accepted: true });
  });

  router.get('/api/captcha/challenge', ({ res, query }) => {
    sendJson(res, 200, captcha.createChallenge(query.get('purpose')));
  });

  router.post('/api/onboarding/applications', async ({ req, res, ip }) => {
    limits.onboarding.consume(ip, 'Too many applications from this network. Please try again later.');
    const idempotencyKey = v.validateIdempotencyKey(req.headers['idempotency-key']);
    const input = v.validateOnboarding(await readJson(req));
    // A retry of an already-processed request replays the stored result; every new submission needs a fresh CAPTCHA.
    if (!customers.hasIdempotencyRecord(db, idempotencyKey)) {
      captcha.verifySolution(db, req.headers['x-captcha-solution'], 'onboarding');
    }
    const result = customers.createApplication(db, input, { idempotencyKey });
    sendJson(res, result.status, { ...result.body, replayed: result.replayed }, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
  });

  function bearer(req) {
    const header = String(req.headers.authorization || '');
    return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  }

  router.get('/api/self/consents', ({ req, res, ip }) => {
    limits.selfService.consume(ip);
    sendJson(res, 200, customers.getSelf(db, bearer(req)));
  });

  router.put('/api/self/consents', async ({ req, res, ip }) => {
    limits.selfService.consume(ip);
    const input = v.validateConsentUpdate(await readJson(req));
    sendJson(res, 200, customers.updateConsents(db, bearer(req), input));
  });

  // -------------------------------------------------------------- admin API
  function requireAdmin(ctx) {
    const session = auth.getSession(ctx.cookies[admin.SESSION_COOKIE]);
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in to the admin dashboard');
    return session;
  }

  const adminRoute = (method, pattern, handler) =>
    router[method](pattern, async (ctx) => handler({ ...ctx, session: requireAdmin(ctx) }));

  router.post('/api/admin/login', async ({ req, res, ip }) => {
    limits.loginFailures.check(ip, 'Too many failed sign-in attempts. Please wait 15 minutes.');
    const body = await readJson(req);
    const validator = new v.Validator();
    validator.object(body, '', ['username', 'password', 'captcha']);
    const username = validator.string(body.username, 'username', { max: 100 });
    if (typeof body.password !== 'string' || !body.password || body.password.length > 200) validator.fail('password', 'is required');
    validator.throwIfInvalid();
    captcha.verifySolution(db, body.captcha, 'admin_login');

    if (!auth.verifyCredentials(username, body.password)) {
      limits.loginFailures.hit(ip);
      audit.appendAudit(db, { actorType: 'admin', actorId: username, action: 'ADMIN_LOGIN_FAILED', entityType: 'admin_session', details: {} });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password');
    }
    limits.loginFailures.reset(ip);
    const token = auth.createSession(username);
    audit.appendAudit(db, { actorType: 'admin', actorId: username, action: 'ADMIN_LOGIN', entityType: 'admin_session', details: {} });
    sendJson(res, 200, { username }, { 'Set-Cookie': auth.loginCookie(token) });
  });

  router.post('/api/admin/logout', ({ res, cookies }) => {
    const token = cookies[admin.SESSION_COOKIE];
    const session = auth.getSession(token);
    auth.destroySession(token);
    if (session) audit.appendAudit(db, { actorType: 'admin', actorId: session.username, action: 'ADMIN_LOGOUT', entityType: 'admin_session', details: {} });
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
  });

  adminRoute('get', '/api/admin/me', ({ res, session }) => sendJson(res, 200, { username: session.username, usingDevPassword: config.admin.usingDevPassword }));

  adminRoute('get', '/api/admin/stats', ({ res }) => sendJson(res, 200, admin.getStats(db)));

  adminRoute('get', '/api/admin/customers', ({ res, query }) => {
    const purpose = query.get('purpose') || undefined;
    const status = query.get('status') || undefined;
    if (purpose && !config.privacyNotice.purposes.some((p) => p.id === purpose)) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown purpose');
    if (status && !['acknowledged', 'granted', 'denied', 'withdrawn'].includes(status)) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown status');
    const q = (query.get('q') || '').slice(0, 100);
    sendJson(res, 200, { customers: customers.listCustomers(db, { q, purpose, status }) });
  });

  adminRoute('get', '/api/admin/customers/:id', ({ res, params }) => {
    const customer = customers.getCustomerForAdmin(db, params.id);
    sendJson(res, 200, { customer, audit: audit.listAudit(db, { entityType: 'customer', entityId: params.id }) });
  });

  adminRoute('post', '/api/admin/customers/:id/reveal', async ({ req, res, params, session }) => {
    const body = await readJson(req);
    const validator = new v.Validator();
    validator.object(body, '', ['reason']);
    const reason = validator.string(body.reason, 'reason', { min: 5, max: 200 });
    validator.throwIfInvalid();
    sendJson(res, 200, { pii: customers.revealCustomerPii(db, params.id, { adminUser: session.username, reason }) });
  });

  adminRoute('get', '/api/admin/cookie-consents', ({ res, query }) => {
    const action = query.get('action') || undefined;
    const category = query.get('category') || undefined;
    if (action && !['accept_all', 'reject_optional', 'custom'].includes(action)) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown action');
    if (category && !['analytics', 'marketing', 'none'].includes(category)) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown category');
    const visitor = (query.get('visitor') || '').replace(/[^0-9a-f-]/gi, '').slice(0, 36) || undefined;
    const latestOnly = query.get('history') !== 'all';
    sendJson(res, 200, { consents: cookieConsents.listCookieConsents(db, { action, category, visitor, latestOnly }) });
  });

  adminRoute('get', '/api/admin/cookie-consents/visitors/:visitorId', ({ res, params }) => {
    if (!v.UUID_RE.test(params.visitorId)) throw new ApiError(422, 'VALIDATION_FAILED', 'visitorId must be a UUID');
    sendJson(res, 200, {
      visitorId: params.visitorId,
      history: cookieConsents.visitorHistory(db, params.visitorId.toLowerCase()),
      audit: audit.listAudit(db, { entityType: 'cookie_consent', entityId: params.visitorId.toLowerCase() }),
    });
  });

  adminRoute('get', '/api/admin/audit', ({ res, query }) => {
    const limit = parseInt(query.get('limit') || '200', 10) || 200;
    sendJson(res, 200, {
      entries: audit.listAudit(db, { action: query.get('action') || undefined, entityType: query.get('entityType') || undefined, limit }),
      actions: audit.distinctActions(db),
    });
  });

  adminRoute('get', '/api/admin/audit/verify', ({ res }) => sendJson(res, 200, audit.verifyChain(db)));

  adminRoute('get', '/api/admin/policies', ({ res }) => sendJson(res, 200, { policies: admin.listPolicyVersions(db) }));
}

module.exports = { registerRoutes, publicConsentConfig };
