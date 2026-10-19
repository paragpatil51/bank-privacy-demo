'use strict';

/**
 * Central configuration. Policy versions, cookie categories and processing
 * purposes live here so the website, the API and the dashboard all share a
 * single source of truth.
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

function intFromEnv(name, fallback) {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const DEV_ADMIN_PASSWORD = 'BankDemo@2026';

module.exports = {
  env,
  isProduction,
  port: intFromEnv('PORT', 3000),
  host: process.env.HOST || '127.0.0.1',
  rootDir: ROOT,
  publicDir: path.join(ROOT, 'public'),
  dataDir,
  dbFile: process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(dataDir, 'bank-demo.db'),
  // Only trust X-Forwarded-For when running behind a known reverse proxy.
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Host-header allow-list (defends against DNS rebinding). Add your public hostname in deployment.
  allowedHosts: (process.env.ALLOWED_HOSTS || 'localhost,127.0.0.1,[::1]')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  logRequests: process.env.LOG_REQUESTS !== 'false',

  bank: {
    name: 'Bihar Cooperative Bank Ltd.',
    branches: [
      { id: 'patna_main', name: 'Patna Main Branch, Fraser Road' },
      { id: 'patna_kankarbagh', name: 'Patna – Kankarbagh' },
      { id: 'gaya', name: 'Gaya' },
      { id: 'muzaffarpur', name: 'Muzaffarpur' },
      { id: 'bhagalpur', name: 'Bhagalpur' },
      { id: 'darbhanga', name: 'Darbhanga' },
      { id: 'purnia', name: 'Purnia' },
    ],
    accountTypes: [
      { id: 'savings', name: 'Savings Account' },
      { id: 'current', name: 'Current Account' },
      { id: 'fixed_deposit', name: 'Fixed Deposit' },
      { id: 'recurring_deposit', name: 'Recurring Deposit' },
    ],
  },

  cookiePolicy: {
    version: '1.0',
    effectiveFrom: '2026-10-01',
    consentMaxAgeDays: 180,
    cookieName: 'bcb_consent',
    categories: [
      {
        id: 'necessary',
        title: 'Strictly necessary',
        required: true,
        description:
          'Essential for the website to work securely, for example remembering your cookie choices. These cannot be switched off and do not track you.',
        cookies: [
          {
            name: 'bcb_consent',
            provider: 'Bihar Cooperative Bank (first party)',
            purpose: 'Stores your cookie choices, consent ID and policy version so we respect them on later visits.',
            duration: '180 days',
          },
          {
            name: 'bcb_admin_session',
            provider: 'Bihar Cooperative Bank (first party)',
            purpose: 'Keeps authorised staff signed in to the consent admin dashboard. Set only after staff login.',
            duration: '30 minutes of inactivity',
          },
        ],
      },
      {
        id: 'analytics',
        title: 'Analytics',
        required: false,
        description:
          'Help us understand how visitors use the website (pages visited, visit length) so we can improve it.',
        cookies: [
          {
            name: '_bcb_an_id',
            provider: 'Demo Analytics (simulated third party)',
            purpose: 'Distinguishes unique visitors for page-view statistics.',
            duration: '1 year',
          },
          {
            name: '_bcb_an_session',
            provider: 'Demo Analytics (simulated third party)',
            purpose: 'Groups page views into a single visit.',
            duration: '30 minutes',
          },
        ],
      },
      {
        id: 'marketing',
        title: 'Marketing',
        required: false,
        description:
          'Measure our advertising campaigns and show you relevant offers for our products on other websites.',
        cookies: [
          {
            name: '_bcb_mkt_id',
            provider: 'Demo Ads Network (simulated third party)',
            purpose: 'Identifies your browser to measure campaign conversions and personalise offers.',
            duration: '90 days',
          },
        ],
      },
    ],
  },

  privacyNotice: {
    version: '2026.10',
    effectiveFrom: '2026-10-01',
    manageTokenTtlDays: 30,
    purposes: [
      {
        id: 'account_opening',
        title: 'Account opening, KYC and regulatory compliance',
        legalBasis: 'necessary',
        required: true,
        description:
          'We use your name, email, mobile number and date of birth to process your account-opening request, verify your identity (KYC) and meet our legal obligations under RBI and anti-money-laundering rules. This is needed to open the account you asked for.',
        dataUsed: ['Full name', 'Email', 'Mobile number', 'Date of birth', 'Account type', 'Branch'],
      },
      {
        id: 'marketing_communications',
        title: 'Marketing communications',
        legalBasis: 'consent',
        required: false,
        description:
          'Send you offers about our deposits, loans and other products by email and SMS. Optional: your account is not affected if you say no, and you can withdraw at any time.',
        dataUsed: ['Full name', 'Email', 'Mobile number'],
      },
      {
        id: 'third_party_sharing',
        title: 'Sharing with our insurance partner',
        legalBasis: 'consent',
        required: false,
        description:
          'Share your name, email and mobile number with our insurance partner, Ganga Demo Insurance Ltd. (fictional), so they can contact you about insurance products. Optional: you can withdraw at any time.',
        dataUsed: ['Full name', 'Email', 'Mobile number'],
      },
    ],
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD || (isProduction ? null : DEV_ADMIN_PASSWORD),
    usingDevPassword: !process.env.ADMIN_PASSWORD,
    sessionIdleMinutes: 30,
    sessionAbsoluteHours: 8,
  },

  limits: {
    bodyBytes: 16 * 1024,
  },

  rateLimits: {
    api: { windowMs: 60 * 1000, max: intFromEnv('RATE_LIMIT_API', 300) },
    cookieConsent: { windowMs: 60 * 1000, max: intFromEnv('RATE_LIMIT_COOKIE', 30) },
    onboarding: { windowMs: 60 * 60 * 1000, max: intFromEnv('RATE_LIMIT_ONBOARDING', 20) },
    selfService: { windowMs: 15 * 60 * 1000, max: intFromEnv('RATE_LIMIT_SELF_SERVICE', 60) },
    loginFailures: { windowMs: 15 * 60 * 1000, max: intFromEnv('RATE_LIMIT_LOGIN', 5) },
  },
};
