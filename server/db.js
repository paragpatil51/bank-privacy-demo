'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS policy_versions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_type     TEXT NOT NULL CHECK (policy_type IN ('cookie_policy', 'privacy_notice')),
  version         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  effective_from  TEXT NOT NULL,
  registered_at   TEXT NOT NULL,
  UNIQUE (policy_type, version)
);

CREATE TABLE IF NOT EXISTS customers (
  id                        TEXT PRIMARY KEY,
  reference_id              TEXT NOT NULL UNIQUE,
  full_name_enc             TEXT NOT NULL,
  email_enc                 TEXT NOT NULL,
  email_hash                TEXT NOT NULL UNIQUE,
  mobile_enc                TEXT NOT NULL,
  mobile_hash               TEXT NOT NULL UNIQUE,
  dob_enc                   TEXT NOT NULL,
  account_type              TEXT NOT NULL,
  branch                    TEXT NOT NULL,
  application_status        TEXT NOT NULL DEFAULT 'submitted',
  manage_token_hash         TEXT NOT NULL UNIQUE,
  manage_token_expires_at   TEXT NOT NULL,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- Current consent state: exactly one row per customer and purpose.
CREATE TABLE IF NOT EXISTS customer_consents (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  purpose         TEXT NOT NULL,
  legal_basis     TEXT NOT NULL CHECK (legal_basis IN ('necessary', 'consent')),
  status          TEXT NOT NULL CHECK (status IN ('acknowledged', 'granted', 'denied', 'withdrawn')),
  notice_version  TEXT NOT NULL,
  source          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (customer_id, purpose),
  CHECK ((legal_basis = 'necessary' AND status = 'acknowledged') OR
         (legal_basis = 'consent' AND status IN ('granted', 'denied', 'withdrawn')))
);

-- Immutable history of every consent state transition.
CREATE TABLE IF NOT EXISTS consent_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  consent_id       TEXT NOT NULL REFERENCES customer_consents(id),
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  purpose          TEXT NOT NULL,
  previous_status  TEXT,
  new_status       TEXT NOT NULL,
  notice_version   TEXT NOT NULL,
  source           TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_events_customer ON consent_events (customer_id, id);

-- Every cookie decision is a new row; the latest row per visitor is the active one.
CREATE TABLE IF NOT EXISTS cookie_consents (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  visitor_id      TEXT NOT NULL,
  necessary       INTEGER NOT NULL DEFAULT 1 CHECK (necessary = 1),
  analytics       INTEGER NOT NULL CHECK (analytics IN (0, 1)),
  marketing       INTEGER NOT NULL CHECK (marketing IN (0, 1)),
  action          TEXT NOT NULL CHECK (action IN ('accept_all', 'reject_optional', 'custom')),
  policy_version  TEXT NOT NULL,
  ip_hash         TEXT,
  user_agent      TEXT,
  created_at      TEXT NOT NULL,
  CHECK (action <> 'accept_all' OR (analytics = 1 AND marketing = 1)),
  CHECK (action <> 'reject_optional' OR (analytics = 0 AND marketing = 0))
);
CREATE INDEX IF NOT EXISTS idx_cookie_consents_visitor ON cookie_consents (visitor_id, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope            TEXT NOT NULL,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_enc     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Events sent by the demo analytics / marketing scripts (only accepted with consent).
CREATE TABLE IF NOT EXISTS telemetry_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT NOT NULL CHECK (category IN ('analytics', 'marketing')),
  visitor_id  TEXT NOT NULL,
  consent_id  TEXT NOT NULL,
  path        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Single-use proof-of-work CAPTCHA challenges (replay protection).
CREATE TABLE IF NOT EXISTS captcha_used (
  challenge   TEXT PRIMARY KEY,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash           TEXT PRIMARY KEY,
  username             TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  expires_at           TEXT NOT NULL,
  absolute_expires_at  TEXT NOT NULL
);

-- Append-only, HMAC hash-chained audit trail.
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at  TEXT NOT NULL,
  actor_type   TEXT NOT NULL CHECK (actor_type IN ('customer', 'visitor', 'admin', 'system')),
  actor_id     TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  details      TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_events_no_update BEFORE UPDATE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS consent_events_no_delete BEFORE DELETE ON consent_events
BEGIN SELECT RAISE(ABORT, 'consent_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS cookie_consents_no_update BEFORE UPDATE ON cookie_consents
BEGIN SELECT RAISE(ABORT, 'cookie_consents is append-only'); END;
`;

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** Runs fn inside a write transaction; rolls back on any error. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDatabase, transaction };
