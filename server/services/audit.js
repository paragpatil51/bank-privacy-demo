'use strict';

/**
 * Append-only audit trail. Each entry stores an HMAC over its own content and
 * the previous entry's hash, so editing or deleting any row (even directly in
 * the database) breaks the chain and is detected by verifyChain(). The HMAC key
 * is held outside the database, so an attacker with only DB access cannot
 * re-compute a valid chain. Details never contain raw personal data.
 */
const { hmac } = require('../lib/crypto');

const GENESIS = 'GENESIS';

function entryHash(prevHash, e) {
  return hmac('audit', [prevHash, e.occurred_at, e.actor_type, e.actor_id ?? '', e.action, e.entity_type, e.entity_id ?? '', e.details].join('|'));
}

function appendAudit(db, { actorType, actorId = null, action, entityType, entityId = null, details = {} }) {
  const last = db.prepare('SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1').get();
  const entry = {
    occurred_at: new Date().toISOString(),
    actor_type: actorType,
    actor_id: actorId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: JSON.stringify(details),
  };
  const prevHash = last ? last.hash : GENESIS;
  const hash = entryHash(prevHash, entry);
  db.prepare(
    `INSERT INTO audit_log (occurred_at, actor_type, actor_id, action, entity_type, entity_id, details, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(entry.occurred_at, entry.actor_type, entry.actor_id, entry.action, entry.entity_type, entry.entity_id, entry.details, prevHash, hash);
}

function verifyChain(db) {
  let prevHash = GENESIS;
  let checked = 0;
  for (const row of db.prepare('SELECT * FROM audit_log ORDER BY id').iterate()) {
    if (row.prev_hash !== prevHash || entryHash(prevHash, row) !== row.hash) {
      return { valid: false, checked, brokenAtId: row.id };
    }
    prevHash = row.hash;
    checked += 1;
  }
  return { valid: true, checked, brokenAtId: null };
}

function toDto(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: JSON.parse(row.details),
    hash: row.hash,
  };
}

function listAudit(db, { action, entityType, entityId, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  params.push(Math.min(Math.max(limit, 1), 500));
  return db.prepare(sql).all(...params).map(toDto);
}

function distinctActions(db) {
  return db.prepare('SELECT DISTINCT action FROM audit_log ORDER BY action').all().map((r) => r.action);
}

module.exports = { appendAudit, verifyChain, listAudit, distinctActions };
