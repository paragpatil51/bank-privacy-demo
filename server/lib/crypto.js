'use strict';

/**
 * Field-level protection for personal data.
 *  - encrypt/decrypt: AES-256-GCM with per-value random IV. The record id and
 *    field name are bound as additional authenticated data (AAD), so a
 *    ciphertext copied into another row or column fails to decrypt.
 *  - blindIndex: keyed HMAC-SHA256 of a normalised value. Lets us enforce
 *    uniqueness and do exact-match search without storing plaintext.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const KEY_ID = 'k1';
let encKey = null;
let hmacKey = null;

function decodeKey(value, name) {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} must be a base64-encoded 32-byte key`);
  return key;
}

function initKeys() {
  let enc = process.env.PII_ENCRYPTION_KEY;
  let mac = process.env.PII_HMAC_KEY;
  if (!enc || !mac) {
    if (config.isProduction) {
      throw new Error('PII_ENCRYPTION_KEY and PII_HMAC_KEY must be provided (e.g. from a KMS / vault) in production');
    }
    const file = path.join(config.dataDir, 'dev-keys.json');
    let stored;
    if (fs.existsSync(file)) {
      stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    } else {
      stored = {
        warning: 'Development-only keys. Never use in production.',
        encryptionKey: crypto.randomBytes(32).toString('base64'),
        hmacKey: crypto.randomBytes(32).toString('base64'),
      };
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(stored, null, 2), { mode: 0o600 });
      console.warn(`[security] Generated development encryption keys at ${file}`);
    }
    enc = enc || stored.encryptionKey;
    mac = mac || stored.hmacKey;
  }
  encKey = decodeKey(enc, 'PII_ENCRYPTION_KEY');
  hmacKey = decodeKey(mac, 'PII_HMAC_KEY');
}

function requireKeys() {
  if (!encKey || !hmacKey) initKeys();
}

function encrypt(plaintext, aad) {
  requireKeys();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [KEY_ID, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

function decrypt(payload, aad) {
  requireKeys();
  const [keyId, ivB64, tagB64, ctB64] = String(payload).split(':');
  if (keyId !== KEY_ID) throw new Error(`Unknown encryption key id: ${keyId}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

function blindIndex(kind, value) {
  requireKeys();
  return crypto.createHmac('sha256', hmacKey).update(`${kind}:${value}`).digest('hex');
}

function hmac(purpose, value) {
  return blindIndex(purpose, value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { initKeys, encrypt, decrypt, blindIndex, hmac, sha256, randomToken, timingSafeEqualStr };
