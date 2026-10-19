'use strict';

/**
 * Loads fictional demo data (customers, consent changes, cookie decisions)
 * through the same service functions the API uses, so the audit trail and
 * consent history are consistent. Safe to run more than once.
 */
const crypto = require('node:crypto');
const config = require('../server/config');
const { openDatabase } = require('../server/db');
const { initKeys, sha256 } = require('../server/lib/crypto');
const customers = require('../server/services/customers');
const cookieConsents = require('../server/services/cookieConsents');
const { registerPolicyVersions } = require('../server/services/admin');

initKeys();
const db = openDatabase(config.dbFile);
registerPolicyVersions(db);

// All people, emails (example.com is reserved for documentation) and numbers are fictional.
const people = [
  ['Aarav Kumar', 'aarav.kumar@example.com', '9876500001', '1990-04-12', 'savings', 'patna_main', true, false, null],
  ['Priya Sinha', 'priya.sinha@example.com', '9876500002', '1985-11-03', 'fixed_deposit', 'gaya', false, false, null],
  ['Rohan Mishra', 'rohan.mishra@example.com', '9876500003', '1998-01-25', 'savings', 'muzaffarpur', true, true, 'withdraw_marketing'],
  ['Sneha Jha', 'sneha.jha@example.com', '9876500004', '1979-07-19', 'current', 'bhagalpur', false, false, 'grant_marketing'],
  ['Vikram Singh', 'vikram.singh@example.com', '9876500005', '1969-02-08', 'recurring_deposit', 'darbhanga', true, false, null],
  ['Ananya Choudhary', 'ananya.choudhary@example.com', '9876500006', '2001-09-30', 'savings', 'purnia', false, true, 'withdraw_sharing'],
  ['Mohammad Imran', 'm.imran@example.com', '9876500007', '1992-12-14', 'current', 'patna_kankarbagh', false, false, null],
  ['Kavita Devi', 'kavita.devi@example.com', '9876500008', '1975-05-21', 'fixed_deposit', 'patna_main', true, true, null],
];

let created = 0;
for (const [fullName, email, mobile, dateOfBirth, accountType, branch, marketing, sharing, change] of people) {
  let result;
  try {
    result = customers.createApplication(db, {
      applicant: { fullName, email, mobile, dateOfBirth, accountType, branch },
      acknowledgements: { account_opening: true },
      consents: { marketing_communications: marketing, third_party_sharing: sharing },
      noticeVersion: config.privacyNotice.version,
    }, { idempotencyKey: `seed-${sha256(email).slice(0, 24)}` });
  } catch (err) {
    if (err.code === 'DUPLICATE_APPLICATION') continue;
    throw err;
  }
  if (result.replayed) continue;
  created += 1;
  const token = result.body.manageConsentUrl.split('#token=')[1];
  const updates = {
    withdraw_marketing: { marketing_communications: false },
    grant_marketing: { marketing_communications: true },
    withdraw_sharing: { third_party_sharing: false },
  }[change];
  if (updates) customers.updateConsents(db, token, { consents: updates, noticeVersion: config.privacyNotice.version });
}

const decisions = [
  ['accept_all', true, true], ['reject_optional', false, false], ['accept_all', true, true], ['custom', true, false],
  ['reject_optional', false, false], ['custom', false, true], ['accept_all', true, true], ['reject_optional', false, false],
  ['custom', true, false], ['accept_all', true, true],
];
const existingCookies = db.prepare('SELECT COUNT(*) AS n FROM cookie_consents').get().n;
if (existingCookies === 0) {
  decisions.forEach(([action, analytics, marketing], i) => {
    const visitorId = crypto.randomUUID();
    const meta = { ip: `203.0.113.${10 + i}`, userAgent: 'Mozilla/5.0 (seed data)' };
    cookieConsents.recordCookieConsent(db, { visitorId, preferences: { necessary: true, analytics, marketing }, action, policyVersion: config.cookiePolicy.version }, meta);
    if (i % 4 === 0) {
      // A visitor who later changes their mind (e.g. withdraws marketing).
      cookieConsents.recordCookieConsent(db, { visitorId, preferences: { necessary: true, analytics: true, marketing: false }, action: 'custom', policyVersion: config.cookiePolicy.version }, meta);
    }
  });
}

db.close();
console.log(`Seed complete: ${created} new customers, ${existingCookies === 0 ? decisions.length : 0} cookie visitors. Database: ${config.dbFile}`);
