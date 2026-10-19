'use strict';

/**
 * Privacy-friendly proof-of-work CAPTCHA (same protocol idea as ALTCHA).
 *
 * The server issues a signed challenge: SHA-256(salt + secretNumber). The
 * browser must find secretNumber by brute force (roughly a second of CPU),
 * which is negligible for a person but makes automated mass submissions
 * expensive. No third-party service, no cookies, no tracking, no image
 * puzzles (accessible). Challenges are HMAC-signed (cannot be forged), bound
 * to a purpose, expire after 10 minutes and can be used only once.
 */
const crypto = require('node:crypto');
const { hmac, randomToken, timingSafeEqualStr } = require('./crypto');
const { ApiError } = require('./http');

const MAX_NUMBER = 50000;
const TTL_MS = 10 * 60 * 1000;
const PURPOSES = ['onboarding', 'admin_login'];

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createChallenge(purpose) {
  if (!PURPOSES.includes(purpose)) throw new ApiError(422, 'VALIDATION_FAILED', 'Unknown CAPTCHA purpose');
  const salt = `${randomToken(12)}?purpose=${purpose}&expires=${Date.now() + TTL_MS}`;
  const challenge = sha256(salt + crypto.randomInt(0, MAX_NUMBER + 1));
  return { algorithm: 'SHA-256', challenge, salt, maxNumber: MAX_NUMBER, signature: hmac('captcha', challenge) };
}

function decode(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2000) return null;
  try {
    const p = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    const valid = p && p.algorithm === 'SHA-256' && typeof p.challenge === 'string' && typeof p.salt === 'string' &&
      typeof p.signature === 'string' && Number.isInteger(p.number) && p.number >= 0 && p.number <= MAX_NUMBER;
    return valid ? p : null;
  } catch {
    return null;
  }
}

/** Verifies a base64 solution and marks it used. Throws 403 on any failure. */
function verifySolution(db, raw, purpose) {
  const fail = (message) => { throw new ApiError(403, 'CAPTCHA_FAILED', message); };
  if (!raw) throw new ApiError(403, 'CAPTCHA_REQUIRED', 'Please complete the human verification and try again.');
  const p = decode(raw);
  if (!p) fail('The human verification is invalid. Please try again.');
  if (!timingSafeEqualStr(p.signature, hmac('captcha', p.challenge))) fail('The human verification is invalid. Please try again.');
  if (sha256(p.salt + p.number) !== p.challenge) fail('The human verification is invalid. Please try again.');
  const params = new URLSearchParams(p.salt.split('?')[1] || '');
  if (params.get('purpose') !== purpose) fail('The human verification is invalid. Please try again.');
  const expires = Number(params.get('expires'));
  if (!expires || expires < Date.now()) fail('The human verification expired. Please try again.');

  db.prepare('DELETE FROM captcha_used WHERE expires_at < ?').run(Date.now());
  const used = db.prepare('INSERT OR IGNORE INTO captcha_used (challenge, expires_at) VALUES (?, ?)').run(p.challenge, expires);
  if (used.changes === 0) fail('This human verification was already used. Please try again.');
}

module.exports = { createChallenge, verifySolution, MAX_NUMBER };
