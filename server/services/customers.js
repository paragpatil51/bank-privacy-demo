'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { transaction } = require('../db');
const { appendAudit } = require('./audit');
const { ApiError } = require('../lib/http');
const { encrypt, decrypt, blindIndex, sha256, randomToken } = require('../lib/crypto');

const PURPOSES = config.privacyNotice.purposes;
const purposeById = Object.fromEntries(PURPOSES.map((p) => [p.id, p]));
const ENCRYPTED_FIELDS = { fullName: 'full_name_enc', email: 'email_enc', mobile: 'mobile_enc', dateOfBirth: 'dob_enc' };
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function referenceId() {
  const bytes = crypto.randomBytes(6);
  const suffix = Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
  return `BCB-${new Date().getUTCFullYear()}-${suffix}`;
}

function maskEmail(email) {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 3))}@${domain}`;
}

function maskMobile(mobile) {
  return `******${mobile.slice(-4)}`;
}

function decryptCustomer(row) {
  const out = {};
  for (const [field, column] of Object.entries(ENCRYPTED_FIELDS)) {
    out[field] = decrypt(row[column], `customers:${row.id}:${field}`);
  }
  return out;
}

function consentDto(row) {
  const purpose = purposeById[row.purpose];
  return {
    id: row.id,
    purpose: row.purpose,
    title: purpose ? purpose.title : row.purpose,
    legalBasis: row.legal_basis,
    status: row.status,
    noticeVersion: row.notice_version,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function eventDto(row) {
  return {
    id: row.id,
    purpose: row.purpose,
    title: purposeById[row.purpose] ? purposeById[row.purpose].title : row.purpose,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    noticeVersion: row.notice_version,
    source: row.source,
    createdAt: row.created_at,
  };
}

function getConsents(db, customerId) {
  const rows = db.prepare('SELECT * FROM customer_consents WHERE customer_id = ?').all(customerId);
  const order = PURPOSES.map((p) => p.id);
  return rows.sort((a, b) => order.indexOf(a.purpose) - order.indexOf(b.purpose)).map(consentDto);
}

function getConsentEvents(db, customerId) {
  return db.prepare('SELECT * FROM consent_events WHERE customer_id = ? ORDER BY id DESC').all(customerId).map(eventDto);
}

function writeConsentChange(db, { consentId, customerId, purpose, previousStatus, newStatus, noticeVersion, source, at }) {
  db.prepare(
    `INSERT INTO consent_events (consent_id, customer_id, purpose, previous_status, new_status, notice_version, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(consentId, customerId, purpose, previousStatus, newStatus, noticeVersion, source, at);
}

/**
 * Creates an onboarding application with its consent records in one atomic
 * transaction. Protected against duplicates by:
 *  - an Idempotency-Key (retries / double submits replay the original response)
 *  - unique blind indexes on email and mobile (one application per person)
 *  - a UNIQUE(customer_id, purpose) constraint on consent rows
 */
function createApplication(db, input, { idempotencyKey }) {
  const requestHash = sha256(JSON.stringify(input));

  return transaction(db, () => {
    db.prepare('DELETE FROM idempotency_keys WHERE created_at < ?').run(new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString());

    const previous = db.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND key = ?').get('onboarding', idempotencyKey);
    if (previous) {
      if (previous.request_hash !== requestHash) {
        throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }
      return { status: previous.response_status, body: JSON.parse(decrypt(previous.response_enc, `idempotency:${idempotencyKey}`)), replayed: true };
    }

    const { applicant } = input;
    const emailHash = blindIndex('email', applicant.email);
    const mobileHash = blindIndex('mobile', applicant.mobile);
    if (db.prepare('SELECT 1 FROM customers WHERE email_hash = ? OR mobile_hash = ?').get(emailHash, mobileHash)) {
      throw new ApiError(409, 'DUPLICATE_APPLICATION',
        'An application already exists for this email address or mobile number. Please use your consent management link or contact customer support.');
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const manageToken = randomToken();
    const tokenExpiry = new Date(Date.now() + config.privacyNotice.manageTokenTtlDays * 86400000).toISOString();
    const enc = (field) => encrypt(applicant[field], `customers:${id}:${field}`);

    let ref;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      ref = referenceId();
      if (!db.prepare('SELECT 1 FROM customers WHERE reference_id = ?').get(ref)) break;
    }

    db.prepare(
      `INSERT INTO customers (id, reference_id, full_name_enc, email_enc, email_hash, mobile_enc, mobile_hash, dob_enc,
         account_type, branch, application_status, manage_token_hash, manage_token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)`
    ).run(id, ref, enc('fullName'), enc('email'), emailHash, enc('mobile'), mobileHash, enc('dateOfBirth'),
      applicant.accountType, applicant.branch, sha256(manageToken), tokenExpiry, now, now);

    appendAudit(db, {
      actorType: 'customer', actorId: id, action: 'CUSTOMER_APPLICATION_SUBMITTED', entityType: 'customer', entityId: id,
      details: { referenceId: ref, accountType: applicant.accountType, branch: applicant.branch, noticeVersion: input.noticeVersion },
    });

    for (const purpose of PURPOSES) {
      const status = purpose.legalBasis === 'necessary' ? 'acknowledged' : input.consents[purpose.id] ? 'granted' : 'denied';
      const consentId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO customer_consents (id, customer_id, purpose, legal_basis, status, notice_version, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'web_onboarding', ?, ?)`
      ).run(consentId, id, purpose.id, purpose.legalBasis, status, input.noticeVersion, now, now);
      writeConsentChange(db, { consentId, customerId: id, purpose: purpose.id, previousStatus: null, newStatus: status, noticeVersion: input.noticeVersion, source: 'web_onboarding', at: now });
      appendAudit(db, {
        actorType: 'customer', actorId: id, action: 'CONSENT_RECORDED', entityType: 'customer', entityId: id,
        details: { consentId, purpose: purpose.id, legalBasis: purpose.legalBasis, status, noticeVersion: input.noticeVersion, source: 'web_onboarding' },
      });
    }

    const body = {
      referenceId: ref,
      submittedAt: now,
      applicant: {
        fullName: applicant.fullName,
        email: maskEmail(applicant.email),
        mobile: maskMobile(applicant.mobile),
        accountType: applicant.accountType,
        branch: applicant.branch,
      },
      noticeVersion: input.noticeVersion,
      consents: getConsents(db, id),
      manageConsentUrl: `/manage-consent.html#token=${manageToken}`,
      manageConsentExpiresAt: tokenExpiry,
    };

    // The stored replay response contains the management token, so it is encrypted.
    db.prepare('INSERT INTO idempotency_keys (scope, key, request_hash, response_status, response_enc, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('onboarding', idempotencyKey, requestHash, 201, encrypt(JSON.stringify(body), `idempotency:${idempotencyKey}`), now);

    return { status: 201, body, replayed: false };
  });
}

/** True when this key already produced a stored response (a replay needs no new CAPTCHA). */
function hasIdempotencyRecord(db, idempotencyKey) {
  return Boolean(db.prepare('SELECT 1 FROM idempotency_keys WHERE scope = ? AND key = ? AND created_at >= ?')
    .get('onboarding', idempotencyKey, new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString()));
}

function findByManageToken(db, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) {
    throw new ApiError(401, 'INVALID_TOKEN', 'This consent management link is invalid or has expired.');
  }
  const row = db.prepare('SELECT * FROM customers WHERE manage_token_hash = ?').get(sha256(token));
  if (!row || row.manage_token_expires_at < new Date().toISOString()) {
    throw new ApiError(401, 'INVALID_TOKEN', 'This consent management link is invalid or has expired.');
  }
  return row;
}

function selfServiceView(db, row) {
  const pii = decryptCustomer(row);
  return {
    referenceId: row.reference_id,
    applicant: { fullName: pii.fullName, email: maskEmail(pii.email), mobile: maskMobile(pii.mobile) },
    currentNoticeVersion: config.privacyNotice.version,
    consents: getConsents(db, row.id),
    history: getConsentEvents(db, row.id),
  };
}

function getSelf(db, token) {
  return selfServiceView(db, findByManageToken(db, token));
}

/**
 * Applies a customer's own consent changes. Only optional purposes can change.
 * Turning a purpose off after it was granted is recorded as "withdrawn";
 * unchanged values are no-ops so repeat saves never create duplicate events.
 */
function updateConsents(db, token, input, { source = 'self_service' } = {}) {
  return transaction(db, () => {
    const customer = findByManageToken(db, token);
    const now = new Date().toISOString();
    const changes = [];
    for (const [purpose, wants] of Object.entries(input.consents)) {
      const current = db.prepare('SELECT * FROM customer_consents WHERE customer_id = ? AND purpose = ?').get(customer.id, purpose);
      if (!current || current.legal_basis !== 'consent') {
        throw new ApiError(422, 'INVALID_PURPOSE', `Consent for ${purpose} cannot be changed`);
      }
      const next = wants ? 'granted' : current.status === 'granted' ? 'withdrawn' : current.status;
      if (next === current.status) continue;

      db.prepare('UPDATE customer_consents SET status = ?, notice_version = ?, source = ?, updated_at = ? WHERE id = ?')
        .run(next, input.noticeVersion, source, now, current.id);
      writeConsentChange(db, { consentId: current.id, customerId: customer.id, purpose, previousStatus: current.status, newStatus: next, noticeVersion: input.noticeVersion, source, at: now });
      appendAudit(db, {
        actorType: 'customer', actorId: customer.id,
        action: next === 'granted' ? 'CONSENT_GRANTED' : 'CONSENT_WITHDRAWN',
        entityType: 'customer', entityId: customer.id,
        details: { consentId: current.id, purpose, from: current.status, to: next, noticeVersion: input.noticeVersion, source },
      });
      changes.push({ purpose, from: current.status, to: next });
    }
    if (changes.length) db.prepare('UPDATE customers SET updated_at = ? WHERE id = ?').run(now, customer.id);
    return { changes, ...selfServiceView(db, db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id)) };
  });
}

// ---------------------------------------------------------------- admin views

function summaryRow(db, row) {
  const pii = decryptCustomer(row);
  return {
    id: row.id,
    referenceId: row.reference_id,
    fullName: pii.fullName,
    email: maskEmail(pii.email),
    mobile: maskMobile(pii.mobile),
    accountType: row.account_type,
    branch: row.branch,
    applicationStatus: row.application_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    consents: Object.fromEntries(getConsents(db, row.id).map((c) => [c.purpose, c.status])),
  };
}

/**
 * Search: exact email / mobile matches use the blind index (no decryption);
 * reference IDs match by prefix; names are matched after decryption, which is
 * acceptable at demo scale (production would use a tokenised search service).
 */
function listCustomers(db, { q, purpose, status, limit = 200 } = {}) {
  const where = [];
  const params = [];
  let nameQuery = null;
  const query = (q || '').trim();
  if (query) {
    const digits = query.replace(/[\s+()-]/g, '').replace(/^91(?=\d{10}$)/, '');
    if (query.includes('@')) {
      where.push('email_hash = ?');
      params.push(blindIndex('email', query.toLowerCase()));
    } else if (/^[6-9]\d{9}$/.test(digits)) {
      where.push('mobile_hash = ?');
      params.push(blindIndex('mobile', digits));
    } else if (/^BCB-/i.test(query)) {
      where.push('reference_id LIKE ?');
      params.push(`${query.toUpperCase()}%`);
    } else {
      nameQuery = query.toLowerCase();
    }
  }
  if (purpose || status) {
    const sub = [];
    if (purpose) { sub.push('purpose = ?'); params.push(purpose); }
    if (status) { sub.push('status = ?'); params.push(status); }
    where.push(`id IN (SELECT customer_id FROM customer_consents WHERE ${sub.join(' AND ')})`);
  }
  const rows = db.prepare(`SELECT * FROM customers ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`).all(...params);
  let result = rows.map((r) => summaryRow(db, r));
  if (nameQuery) result = result.filter((c) => c.fullName.toLowerCase().includes(nameQuery));
  return result.slice(0, Math.min(Math.max(limit, 1), 500));
}

function getCustomerForAdmin(db, id) {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Customer not found');
  return {
    ...summaryRow(db, row),
    dateOfBirth: '****-**-**',
    consentRecords: getConsents(db, row.id),
    history: getConsentEvents(db, row.id),
    manageTokenExpiresAt: row.manage_token_expires_at,
  };
}

function revealCustomerPii(db, id, { adminUser, reason }) {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Customer not found');
  appendAudit(db, {
    actorType: 'admin', actorId: adminUser, action: 'PII_REVEALED', entityType: 'customer', entityId: id,
    details: { referenceId: row.reference_id, reason, fields: Object.keys(ENCRYPTED_FIELDS) },
  });
  return decryptCustomer(row);
}

module.exports = {
  createApplication,
  hasIdempotencyRecord,
  getSelf,
  updateConsents,
  listCustomers,
  getCustomerForAdmin,
  revealCustomerPii,
  maskEmail,
  maskMobile,
};
