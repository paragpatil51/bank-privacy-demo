'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const config = require('./config');
const { openDatabase } = require('./db');
const { initKeys } = require('./lib/crypto');
const { ApiError, sendJson, parseCookies, clientIp, Router, createRateLimiter } = require('./lib/http');
const { registerRoutes, publicConsentConfig } = require('./routes');
const { registerPolicyVersions } = require('./services/admin');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function securityHeaders(res) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Trusted Types: the only script URL the page may create is via the CMP's vetted policy.
    "require-trusted-types-for 'script'",
    'trusted-types bcb-cmp',
  ];
  if (config.isProduction) csp.push('upgrade-insecure-requests');
  res.setHeader('Content-Security-Policy', csp.join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function hostAllowed(hostHeader) {
  const host = String(hostHeader || '').toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return config.allowedHosts.includes(name);
}

/** JSON embedded in HTML must not be able to close the <script> element. */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cookieTableHtml() {
  const rows = config.cookiePolicy.categories.flatMap((cat) => cat.cookies.map((ck) =>
    `<tr><td><code>${escapeHtml(ck.name)}</code></td><td>${escapeHtml(cat.title)}${cat.required ? '' : ' (optional)'}</td><td>${escapeHtml(ck.purpose)}</td><td>${escapeHtml(ck.provider)}</td><td>${escapeHtml(ck.duration)}</td></tr>`));
  return `<table><thead><tr><th scope="col">Cookie</th><th scope="col">Category</th><th scope="col">Purpose</th><th scope="col">Provider</th><th scope="col">Duration</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function purposesTableHtml() {
  const rows = config.privacyNotice.purposes.map((p) =>
    `<tr><td><strong>${escapeHtml(p.title)}</strong></td><td>${escapeHtml(p.description)}</td><td>${escapeHtml(p.dataUsed.join(', '))}</td><td>${p.legalBasis === 'necessary' ? 'Necessary for the service you requested and legal obligations' : 'Your consent (optional, withdraw any time)'}</td></tr>`);
  return `<table><thead><tr><th scope="col">Purpose</th><th scope="col">What we do</th><th scope="col">Data used</th><th scope="col">Basis</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function createTemplateRenderer() {
  const partialsDir = path.join(config.publicDir, 'partials');
  const cache = new Map();
  const consentConfig = publicConsentConfig();
  const vars = {
    COOKIE_TABLE_HTML: cookieTableHtml(),
    PURPOSES_TABLE_HTML: purposesTableHtml(),
    COOKIE_POLICY_VERSION: config.cookiePolicy.version,
    COOKIE_POLICY_DATE: config.cookiePolicy.effectiveFrom,
    PRIVACY_NOTICE_VERSION: config.privacyNotice.version,
    PRIVACY_NOTICE_DATE: config.privacyNotice.effectiveFrom,
    YEAR: String(new Date().getFullYear()),
    CMP_CONFIG_JSON: safeJson({
      policyVersion: config.cookiePolicy.version,
      maxAgeDays: config.cookiePolicy.consentMaxAgeDays,
      cookieName: config.cookiePolicy.cookieName,
      endpoint: '/api/cookie-consents',
      categories: config.cookiePolicy.categories,
    }),
    CONSENT_CONFIG_JSON: safeJson(consentConfig),
  };

  function render(file) {
    if (config.isProduction && cache.has(file)) return cache.get(file);
    let html = fs.readFileSync(file, 'utf8');
    html = html.replace(/<!--#include "([a-z0-9-]+)\.html" -->/g, (_, name) => fs.readFileSync(path.join(partialsDir, `${name}.html`), 'utf8'));
    html = html.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => (key in vars ? vars[key] : match));
    cache.set(file, html);
    return html;
  }
  return render;
}

function serveStatic(req, res, url, render) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = '/';
  }
  const root = config.publicDir;
  const segments = pathname.split('/').filter(Boolean);
  // Block dotfiles, template partials, NUL bytes and ':' (Windows alternate data
  // streams / drive letters); path.resolve below blocks traversal.
  const blocked = segments.some((s) => s.startsWith('.')) || segments[0] === 'partials' || /[\0:]/.test(pathname);

  let file = blocked ? null : path.resolve(root, `.${pathname}`);
  if (file && !(file === root || file.startsWith(root + path.sep))) file = null;
  if (file) {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      if (!pathname.endsWith('/')) {
        res.writeHead(301, { Location: `${pathname}/${url.search}` });
        return res.end();
      }
      file = path.join(file, 'index.html');
    } else if (!path.extname(file) && fs.existsSync(`${file}.html`)) {
      file = `${file}.html`;
    }
  }

  let status = 200;
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    status = 404;
    file = path.join(root, '404.html');
  }

  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  if (pathname.startsWith('/admin')) headers['X-Robots-Tag'] = 'noindex, nofollow';
  let body;
  if (ext === '.html') {
    body = render(file);
    headers['Cache-Control'] = 'no-cache';
  } else {
    body = fs.readFileSync(file);
    headers['Cache-Control'] = config.isProduction ? 'public, max-age=3600' : 'no-cache';
  }
  res.writeHead(status, { ...headers, 'Content-Length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function createApp({ dbFile = config.dbFile } = {}) {
  initKeys();
  const db = openDatabase(dbFile);
  registerPolicyVersions(db);

  const router = new Router();
  registerRoutes(router, { db });
  const render = createTemplateRenderer();
  const apiLimiter = createRateLimiter(config.rateLimits.api);

  async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    securityHeaders(res);
    if (!hostAllowed(req.headers.host)) {
      // A request for an unknown hostname (e.g. a DNS-rebinding attack) never reaches the app.
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Misdirected request');
      return;
    }
    try {
      if (!url.pathname.startsWith('/api/')) {
        serveStatic(req, res, url, render);
        return;
      }
      res.setHeader('Cache-Control', 'no-store');
      const ip = clientIp(req);
      apiLimiter.consume(ip);

      // CSRF defence: state-changing requests must come from this origin.
      // (Admin cookies are also SameSite=Strict; there is no CORS allowance.)
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
          let originHost = null;
          try { originHost = new URL(origin).host; } catch { /* invalid origin */ }
          if (originHost !== req.headers.host) throw new ApiError(403, 'CROSS_ORIGIN_BLOCKED', 'Cross-origin requests are not allowed');
        }
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'CROSS_ORIGIN_BLOCKED', 'Cross-origin requests are not allowed');
      }

      const match = router.match(req.method, url.pathname);
      if (!match.handler) {
        if (match.allowed.length) {
          throw Object.assign(new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed'), { headers: { Allow: match.allowed.join(', ') } });
        }
        throw new ApiError(404, 'NOT_FOUND', 'Endpoint not found');
      }
      await match.handler({ req, res, url, query: url.searchParams, params: match.params, cookies: parseCookies(req.headers.cookie), ip });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
      } else if (err instanceof ApiError) {
        sendJson(res, err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, err.headers || {});
      } else {
        console.error('[error]', err && err.stack ? err.stack : err);
        sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
      }
    } finally {
      // Never log bodies, query strings or headers: they may carry personal data or tokens.
      if (config.logRequests) {
        console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    }
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error('[fatal]', err);
      if (!res.headersSent) sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong.' } });
    });
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.on('close', () => db.close());
  return { server, db };
}

module.exports = { createApp, createTemplateRenderer };
