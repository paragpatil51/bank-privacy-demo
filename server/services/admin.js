'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { appendAudit } = require('./audit');
const { sha256, randomToken, timingSafeEqualStr } = require('../lib/crypto');

const SESSION_COOKIE = 'bcb_admin_session';

function createAdminAuth(db) {
  if (!config.admin.password) {
    throw new Error('ADMIN_PASSWORD must be set in production');
  }
  // Only a salted scrypt hash of the password is kept in memory.
  const salt = crypto.randomBytes(16);
  const passwordHash = crypto.scryptSync(config.admin.password, salt, 64);

  function verifyCredentials(username, password) {
    const userOk = timingSafeEqualStr(String(username), config.admin.username);
    const candidate = crypto.scryptSync(String(password), salt, 64);
    const passOk = crypto.timingSafeEqual(candidate, passwordHash);
    return userOk && passOk;
  }

  function createSession(username) {
    const token = randomToken();
    const now = Date.now();
    db.prepare('DELETE FROM admin_sessions WHERE expires_at < ? OR absolute_expires_at < ?').run(new Date(now).toISOString(), new Date(now).toISOString());
    db.prepare('INSERT INTO admin_sessions (token_hash, username, created_at, expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?)').run(
      sha256(token), username, new Date(now).toISOString(),
      new Date(now + config.admin.sessionIdleMinutes * 60000).toISOString(),
      new Date(now + config.admin.sessionAbsoluteHours * 3600000).toISOString()
    );
    return token;
  }

  /** Returns the session (sliding idle expiry) or null. */
  function getSession(token) {
    if (!token) return null;
    const now = new Date();
    const row = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?').get(sha256(token));
    if (!row) return null;
    if (row.expires_at < now.toISOString() || row.absolute_expires_at < now.toISOString()) {
      db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    db.prepare('UPDATE admin_sessions SET expires_at = ? WHERE token_hash = ?')
      .run(new Date(now.getTime() + config.admin.sessionIdleMinutes * 60000).toISOString(), row.token_hash);
    return { username: row.username, createdAt: row.created_at };
  }

  function destroySession(token) {
    if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  }

  function sessionCookie(token, maxAgeSeconds) {
    const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/api/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
    if (config.isProduction) parts.push('Secure');
    return parts.join('; ');
  }

  return {
    verifyCredentials,
    createSession,
    getSession,
    destroySession,
    loginCookie: (token) => sessionCookie(token, config.admin.sessionAbsoluteHours * 3600),
    clearCookie: () => sessionCookie('', 0),
  };
}

function getStats(db) {
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const customers = one('SELECT COUNT(*) AS n FROM customers').n;
  const consentRecords = one('SELECT COUNT(*) AS n FROM customer_consents').n;
  const consentEvents = one('SELECT COUNT(*) AS n FROM consent_events').n;

  const byPurpose = {};
  for (const p of config.privacyNotice.purposes) {
    byPurpose[p.id] = { title: p.title, legalBasis: p.legalBasis, acknowledged: 0, granted: 0, denied: 0, withdrawn: 0 };
  }
  for (const r of db.prepare('SELECT purpose, status, COUNT(*) AS n FROM customer_consents GROUP BY purpose, status').all()) {
    if (byPurpose[r.purpose]) byPurpose[r.purpose][r.status] = r.n;
  }

  const latest = `SELECT c.* FROM cookie_consents c JOIN (SELECT visitor_id, MAX(seq) AS seq FROM cookie_consents GROUP BY visitor_id) l ON l.seq = c.seq`;
  const cookieRow = one(`SELECT COUNT(*) AS visitors,
      COALESCE(SUM(action = 'accept_all'), 0) AS accept_all,
      COALESCE(SUM(action = 'reject_optional'), 0) AS reject_optional,
      COALESCE(SUM(action = 'custom'), 0) AS custom,
      COALESCE(SUM(analytics), 0) AS analytics,
      COALESCE(SUM(marketing), 0) AS marketing,
      COALESCE(SUM(policy_version <> ?), 0) AS outdated
    FROM (${latest})`, config.cookiePolicy.version);

  const telemetry = { analytics: 0, marketing: 0 };
  for (const r of db.prepare('SELECT category, COUNT(*) AS n FROM telemetry_events GROUP BY category').all()) telemetry[r.category] = r.n;

  return {
    customers,
    consentRecords,
    consentEvents,
    byPurpose,
    cookies: {
      visitors: cookieRow.visitors,
      totalRecords: one('SELECT COUNT(*) AS n FROM cookie_consents').n,
      acceptAll: cookieRow.accept_all,
      rejectOptional: cookieRow.reject_optional,
      custom: cookieRow.custom,
      analyticsGranted: cookieRow.analytics,
      marketingGranted: cookieRow.marketing,
      outdatedPolicy: cookieRow.outdated,
    },
    telemetry,
    auditEntries: one('SELECT COUNT(*) AS n FROM audit_log').n,
    policyVersions: { cookiePolicy: config.cookiePolicy.version, privacyNotice: config.privacyNotice.version },
  };
}

/**
 * Registers the current policy versions with a hash of the published policy
 * page. If a policy page changes without a version bump we warn, because
 * consents would then point at a version whose wording has silently changed.
 */
function registerPolicyVersions(db) {
  const policies = [
    { type: 'cookie_policy', version: config.cookiePolicy.version, effectiveFrom: config.cookiePolicy.effectiveFrom, file: 'cookie-policy.html', extra: config.cookiePolicy.categories },
    { type: 'privacy_notice', version: config.privacyNotice.version, effectiveFrom: config.privacyNotice.effectiveFrom, file: 'privacy-policy.html', extra: config.privacyNotice.purposes },
  ];
  for (const p of policies) {
    const filePath = path.join(config.publicDir, p.file);
    const content = (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '') + JSON.stringify(p.extra);
    const hash = sha256(content);
    const existing = db.prepare('SELECT * FROM policy_versions WHERE policy_type = ? AND version = ?').get(p.type, p.version);
    if (!existing) {
      db.prepare('INSERT INTO policy_versions (policy_type, version, content_hash, effective_from, registered_at) VALUES (?, ?, ?, ?, ?)')
        .run(p.type, p.version, hash, p.effectiveFrom, new Date().toISOString());
      appendAudit(db, { actorType: 'system', action: 'POLICY_VERSION_PUBLISHED', entityType: 'policy', entityId: `${p.type}@${p.version}`, details: { contentHash: hash, effectiveFrom: p.effectiveFrom } });
    } else if (existing.content_hash !== hash && !config.isProduction) {
      console.warn(`[policy] ${p.type} content changed but version is still ${p.version}. Bump the version if the change is material.`);
    }
  }
}

function listPolicyVersions(db) {
  return db.prepare('SELECT policy_type, version, content_hash, effective_from, registered_at FROM policy_versions ORDER BY id DESC').all()
    .map((r) => ({ policyType: r.policy_type, version: r.version, contentHash: r.content_hash, effectiveFrom: r.effective_from, registeredAt: r.registered_at }));
}

module.exports = { SESSION_COOKIE, createAdminAuth, getStats, registerPolicyVersions, listPolicyVersions };
