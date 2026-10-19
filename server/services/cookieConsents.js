'use strict';

const crypto = require('node:crypto');
const { transaction } = require('../db');
const { appendAudit } = require('./audit');
const { blindIndex } = require('../lib/crypto');
const { ApiError } = require('../lib/http');
const config = require('../config');

function toDto(row) {
  return {
    id: row.id,
    visitorId: row.visitor_id,
    preferences: { necessary: true, analytics: row.analytics === 1, marketing: row.marketing === 1 },
    action: row.action,
    policyVersion: row.policy_version,
    recordedAt: row.created_at,
  };
}

function latestForVisitor(db, visitorId) {
  return db.prepare('SELECT * FROM cookie_consents WHERE visitor_id = ? ORDER BY seq DESC LIMIT 1').get(visitorId);
}

/**
 * Records a cookie decision. Re-submitting the same effective choice for the
 * same policy version is de-duplicated and returns the existing record, so
 * double clicks, retries and multiple tabs cannot create duplicate rows.
 */
function recordCookieConsent(db, input, { ip, userAgent }) {
  return transaction(db, () => {
    const visitorId = input.visitorId || crypto.randomUUID();
    const analytics = input.preferences.analytics ? 1 : 0;
    const marketing = input.preferences.marketing ? 1 : 0;
    const latest = latestForVisitor(db, visitorId);

    if (latest && latest.analytics === analytics && latest.marketing === marketing && latest.policy_version === input.policyVersion) {
      return { consent: toDto(latest), created: false };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO cookie_consents (id, visitor_id, necessary, analytics, marketing, action, policy_version, ip_hash, user_agent, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, visitorId, analytics, marketing, input.action, input.policyVersion, blindIndex('ip', ip), String(userAgent || '').slice(0, 200), now);

    appendAudit(db, {
      actorType: 'visitor',
      actorId: visitorId,
      action: latest ? 'COOKIE_CONSENT_CHANGED' : 'COOKIE_CONSENT_GIVEN',
      entityType: 'cookie_consent',
      entityId: visitorId,
      details: {
        consentId: id,
        decision: input.action,
        policyVersion: input.policyVersion,
        analytics: Boolean(analytics),
        marketing: Boolean(marketing),
        previous: latest
          ? { consentId: latest.id, analytics: latest.analytics === 1, marketing: latest.marketing === 1, policyVersion: latest.policy_version }
          : null,
      },
    });

    return { consent: toDto(latestForVisitor(db, visitorId)), created: true };
  });
}

/** Server-side enforcement: is this category currently consented for the visitor? */
function assertCategoryConsent(db, visitorId, category) {
  const latest = visitorId ? latestForVisitor(db, visitorId) : null;
  const granted = latest && latest.policy_version === config.cookiePolicy.version && latest[category] === 1;
  if (!granted) {
    throw new ApiError(403, 'CONSENT_REQUIRED', `No valid ${category} consent is recorded for this visitor`);
  }
  return latest;
}

function recordTelemetry(db, { category, visitorId, path }) {
  const consent = assertCategoryConsent(db, visitorId, category);
  db.prepare('INSERT INTO telemetry_events (category, visitor_id, consent_id, path, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(category, visitorId, consent.id, path, new Date().toISOString());
}

function listCookieConsents(db, { action, category, visitor, latestOnly = true, limit = 200 } = {}) {
  const where = [];
  const params = [];
  let from = 'cookie_consents c';
  if (latestOnly) {
    from = `cookie_consents c JOIN (SELECT visitor_id, MAX(seq) AS seq FROM cookie_consents GROUP BY visitor_id) l ON l.seq = c.seq`;
  }
  if (action) { where.push('c.action = ?'); params.push(action); }
  if (category === 'analytics') where.push('c.analytics = 1');
  if (category === 'marketing') where.push('c.marketing = 1');
  if (category === 'none') where.push('c.analytics = 0 AND c.marketing = 0');
  if (visitor) { where.push('c.visitor_id LIKE ?'); params.push(`${visitor.toLowerCase()}%`); }
  params.push(Math.min(Math.max(limit, 1), 500));
  const rows = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM cookie_consents h WHERE h.visitor_id = c.visitor_id) AS history_count
     FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY c.seq DESC LIMIT ?`
  ).all(...params);
  return rows.map((r) => ({ ...toDto(r), historyCount: r.history_count, isCurrentPolicy: r.policy_version === config.cookiePolicy.version }));
}

function visitorHistory(db, visitorId) {
  return db.prepare('SELECT * FROM cookie_consents WHERE visitor_id = ? ORDER BY seq DESC').all(visitorId).map(toDto);
}

module.exports = { recordCookieConsent, recordTelemetry, listCookieConsents, visitorHistory, latestForVisitor };
