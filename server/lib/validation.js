'use strict';

/**
 * Strict allow-list validation. Every endpoint rejects unknown fields,
 * wrong types and values outside the allowed set. Optional consents must be
 * explicit booleans; nothing is defaulted to "granted" on the server.
 */
const config = require('../config');
const { ApiError } = require('./http');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NAME_RE = /^\p{L}[\p{L}\p{M} .'-]*$/u;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MOBILE_RE = /^[6-9]\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,100}$/;

class Validator {
  constructor() {
    this.errors = [];
  }

  fail(field, message) {
    this.errors.push({ field, message });
    return undefined;
  }

  object(value, field, allowedKeys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return this.fail(field, 'must be an object');
    }
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) this.fail(field ? `${field}.${key}` : key, 'is not an allowed field');
    }
    return value;
  }

  boolean(value, field) {
    if (typeof value !== 'boolean') return this.fail(field, 'must be true or false');
    return value;
  }

  string(value, field, { min = 1, max = 200 } = {}) {
    if (typeof value !== 'string') return this.fail(field, 'must be a string');
    const v = value.trim().replace(/\s+/g, ' ');
    if (v.length < min) return this.fail(field, min === 1 ? 'is required' : `must be at least ${min} characters`);
    if (v.length > max) return this.fail(field, `must be at most ${max} characters`);
    return v;
  }

  oneOf(value, field, allowed) {
    if (!allowed.includes(value)) return this.fail(field, `must be one of: ${allowed.join(', ')}`);
    return value;
  }

  throwIfInvalid() {
    if (this.errors.length) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Some fields are invalid', this.errors);
    }
  }
}

function normaliseMobile(raw) {
  let digits = String(raw).replace(/[\s()-]/g, '');
  if (digits.startsWith('+91')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function ageOn(dob, today = new Date()) {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const m = today.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function assertCurrentVersion(received, current, code, label) {
  if (received !== current) {
    throw new ApiError(409, code, `The ${label} has been updated (current version ${current}). Please review the latest version and try again.`, {
      currentVersion: current,
      receivedVersion: received ?? null,
    });
  }
}

function validateCookieConsent(body) {
  const v = new Validator();
  v.object(body, '', ['visitorId', 'preferences', 'action', 'policyVersion']);
  let visitorId = null;
  if (body.visitorId !== undefined && body.visitorId !== null) {
    if (typeof body.visitorId !== 'string' || !UUID_RE.test(body.visitorId)) v.fail('visitorId', 'must be a UUID v4');
    else visitorId = body.visitorId.toLowerCase();
  }
  const prefs = v.object(body.preferences, 'preferences', ['necessary', 'analytics', 'marketing']) || {};
  const analytics = v.boolean(prefs.analytics, 'preferences.analytics');
  const marketing = v.boolean(prefs.marketing, 'preferences.marketing');
  if (prefs.necessary !== undefined && prefs.necessary !== true) {
    v.fail('preferences.necessary', 'strictly necessary cookies cannot be disabled');
  }
  const action = v.oneOf(body.action, 'action', ['accept_all', 'reject_optional', 'custom']);
  if (typeof body.policyVersion !== 'string') v.fail('policyVersion', 'is required');
  v.throwIfInvalid();

  // Reject internally inconsistent decisions (e.g. "accept_all" with marketing off).
  if (action === 'accept_all' && !(analytics && marketing)) {
    throw new ApiError(422, 'INCONSISTENT_CONSENT', 'accept_all requires every optional category to be enabled');
  }
  if (action === 'reject_optional' && (analytics || marketing)) {
    throw new ApiError(422, 'INCONSISTENT_CONSENT', 'reject_optional requires every optional category to be disabled');
  }
  assertCurrentVersion(body.policyVersion, config.cookiePolicy.version, 'POLICY_VERSION_MISMATCH', 'cookie policy');

  return { visitorId, preferences: { necessary: true, analytics, marketing }, action, policyVersion: body.policyVersion };
}

function validateOnboarding(body) {
  const v = new Validator();
  v.object(body, '', ['applicant', 'acknowledgements', 'consents', 'noticeVersion']);

  const a = v.object(body.applicant, 'applicant', ['fullName', 'email', 'mobile', 'dateOfBirth', 'accountType', 'branch']) || {};
  const fullName = v.string(a.fullName, 'applicant.fullName', { min: 2, max: 100 });
  if (fullName && !NAME_RE.test(fullName)) v.fail('applicant.fullName', 'may contain only letters, spaces, apostrophes, dots and hyphens');

  let email = v.string(a.email, 'applicant.email', { max: 254 });
  if (email) {
    email = email.toLowerCase();
    if (!EMAIL_RE.test(email)) v.fail('applicant.email', 'must be a valid email address');
  }

  let mobile;
  if (typeof a.mobile !== 'string') v.fail('applicant.mobile', 'is required');
  else {
    mobile = normaliseMobile(a.mobile);
    if (!MOBILE_RE.test(mobile)) v.fail('applicant.mobile', 'must be a valid 10-digit Indian mobile number');
  }

  let dateOfBirth;
  if (typeof a.dateOfBirth !== 'string' || !DATE_RE.test(a.dateOfBirth)) v.fail('applicant.dateOfBirth', 'must be a date (YYYY-MM-DD)');
  else {
    const dob = new Date(`${a.dateOfBirth}T00:00:00Z`);
    if (Number.isNaN(dob.getTime()) || dob.toISOString().slice(0, 10) !== a.dateOfBirth) v.fail('applicant.dateOfBirth', 'is not a valid date');
    else {
      const age = ageOn(dob);
      if (age < 18) v.fail('applicant.dateOfBirth', 'online account opening is available to applicants aged 18 or over; minors can apply at a branch with a guardian');
      else if (age > 120) v.fail('applicant.dateOfBirth', 'is not a valid date of birth');
      else dateOfBirth = a.dateOfBirth;
    }
  }

  const accountType = v.oneOf(a.accountType, 'applicant.accountType', config.bank.accountTypes.map((t) => t.id));
  const branch = v.oneOf(a.branch, 'applicant.branch', config.bank.branches.map((b) => b.id));

  const necessaryPurposes = config.privacyNotice.purposes.filter((p) => p.legalBasis === 'necessary').map((p) => p.id);
  const optionalPurposes = config.privacyNotice.purposes.filter((p) => p.legalBasis === 'consent').map((p) => p.id);

  const ack = v.object(body.acknowledgements, 'acknowledgements', necessaryPurposes) || {};
  for (const id of necessaryPurposes) {
    if (ack[id] !== true) v.fail(`acknowledgements.${id}`, 'must be acknowledged to open an account');
  }

  // Every optional purpose needs an explicit true/false; none can be implied.
  const consents = v.object(body.consents, 'consents', optionalPurposes) || {};
  const consentValues = {};
  for (const id of optionalPurposes) consentValues[id] = v.boolean(consents[id], `consents.${id}`);

  if (typeof body.noticeVersion !== 'string') v.fail('noticeVersion', 'is required');
  v.throwIfInvalid();
  assertCurrentVersion(body.noticeVersion, config.privacyNotice.version, 'NOTICE_VERSION_MISMATCH', 'privacy notice');

  return {
    applicant: { fullName, email, mobile, dateOfBirth, accountType, branch },
    acknowledgements: Object.fromEntries(necessaryPurposes.map((id) => [id, true])),
    consents: consentValues,
    noticeVersion: body.noticeVersion,
  };
}

function validateConsentUpdate(body) {
  const v = new Validator();
  v.object(body, '', ['consents', 'noticeVersion']);
  const optionalPurposes = config.privacyNotice.purposes.filter((p) => p.legalBasis === 'consent').map((p) => p.id);
  const necessaryPurposes = config.privacyNotice.purposes.filter((p) => p.legalBasis === 'necessary').map((p) => p.id);
  const consents = {};
  if (body.consents && typeof body.consents === 'object' && !Array.isArray(body.consents)) {
    for (const key of Object.keys(body.consents)) {
      if (necessaryPurposes.includes(key)) {
        v.fail(`consents.${key}`, 'is required for your account and cannot be changed here; contact the bank to close your account');
      } else if (!optionalPurposes.includes(key)) {
        v.fail(`consents.${key}`, 'is not a known purpose');
      } else {
        consents[key] = v.boolean(body.consents[key], `consents.${key}`);
      }
    }
    if (!Object.keys(body.consents).length) v.fail('consents', 'must include at least one purpose');
  } else {
    v.fail('consents', 'must be an object');
  }
  if (typeof body.noticeVersion !== 'string') v.fail('noticeVersion', 'is required');
  v.throwIfInvalid();
  assertCurrentVersion(body.noticeVersion, config.privacyNotice.version, 'NOTICE_VERSION_MISMATCH', 'privacy notice');
  return { consents, noticeVersion: body.noticeVersion };
}

function validateIdempotencyKey(value) {
  if (value === undefined) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header is required for this request');
  }
  if (!IDEMPOTENCY_RE.test(value)) {
    throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 16-100 characters of letters, digits, "-" or "_"');
  }
  return value;
}

function validateTelemetry(body) {
  const v = new Validator();
  v.object(body, '', ['path', 'event']);
  const path = v.string(body.path, 'path', { max: 200 });
  if (path && !path.startsWith('/')) v.fail('path', 'must be a site-relative path');
  const event = v.oneOf(body.event, 'event', ['page_view']);
  v.throwIfInvalid();
  return { path, event };
}

module.exports = {
  UUID_RE,
  Validator,
  normaliseMobile,
  validateCookieConsent,
  validateOnboarding,
  validateConsentUpdate,
  validateIdempotencyKey,
  validateTelemetry,
};
