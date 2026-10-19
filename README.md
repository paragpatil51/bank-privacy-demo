# Bank Privacy Management Demo: Bihar Cooperative Bank

**Live demo:** https://paragpatil51.github.io/bank-privacy-demo/ (static GitHub Pages edition, see below)

A working prototype of a banking website for **Bihar Cooperative Bank Ltd.** (a fictional bank) integrated with:

1. **Cookie management:** banner, preference centre, real script blocking, consent records.
2. **Customer consent during onboarding:** privacy notice, separate per-purpose consents, review, confirmation, self-service withdrawal.
3. **Consent admin dashboard:** records, search/filter, counts, cookie history, tamper-evident audit trail.
4. **Backend:** REST API, validation, SQLite persistence, encryption of personal data, duplicate prevention.

> This is a fictional interview prototype. It is not an official bank website. Use dummy data only.

---

## 1. Quick start

**Requirements:** Node.js **22.13+** (tested on Node 24). There are **no npm dependencies**: the app uses only Node built-ins (`node:http`, `node:sqlite`, `node:crypto`), so there is nothing to install and no third-party supply-chain risk.

```bash
npm start          # start on http://127.0.0.1:3000
npm run seed       # optional: load fictional demo customers & cookie decisions
npm test           # 35 API/security tests (isolated temp database)
npm run test:e2e   # 50 real-browser checks (needs the server running + Chrome or Edge)
npm run reset      # delete the local database
```

| URL | What |
|---|---|
| http://127.0.0.1:3000/ | Bank website (home, about, contact, support) |
| http://127.0.0.1:3000/open-account.html | Account opening with consent collection |
| http://127.0.0.1:3000/cookie-policy.html | Cookie policy with a **live script/consent status panel** |
| http://127.0.0.1:3000/manage-consent.html#token=… | Customer self-service consent management (link shown after applying) |
| http://127.0.0.1:3000/admin/ | Consent admin dashboard |

**Admin login (development):** `admin` / `BankDemo@2026`, printed on start-up. Override with `ADMIN_USERNAME` / `ADMIN_PASSWORD`. In `NODE_ENV=production` the server refuses to start without an explicit password and encryption keys.

### Static version for GitHub Pages (shareable link)

GitHub Pages can only host static files, so the repository also contains a static build in [docs/](docs/). It has the same pages and the same browser code, but the Node.js API is replaced by an **in-browser mock API** ([static-demo/mock-api.js](static-demo/mock-api.js)). The mock implements the same endpoints, validation, consistency checks, idempotency, duplicate detection, consent history and hash-chained audit trail, preloaded with demo data. Data is stored in the visitor's own browser (`localStorage`), and the admin page has a **Reset demo data** button.

```bash
npm run build:static     # regenerate docs/ after changing anything in public/ or server/config.js
npm run preview:static   # preview at http://127.0.0.1:4000/bank-privacy-demo/ (same sub-path layout as GitHub Pages)
```

**Publishing:** push this repository to GitHub, then go to **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs` → Save**. After about a minute the site is live at `https://<username>.github.io/<repository>/`; the admin dashboard is at `…/admin/` (demo credentials are shown on the login page).

The real server's protections (encryption at rest, HttpOnly sessions, rate limiting, HTTP security headers, secrets kept off the client) cannot exist in a browser-only build. The static demo shows the **behaviour and user journey**; the Node.js server in this repo is the production-style implementation. In the static build:
* A CSP `<meta>` tag (with Trusted Types) keeps the "no inline / third-party scripts" guarantee.
* [static-demo/frame-guard.js](static-demo/frame-guard.js) refuses to render inside another site's frame, because GitHub Pages cannot send `X-Frame-Options`.
* GitHub Pages serves everything over HTTPS with HSTS (`github.io` is HSTS-preloaded).
* No visitor's data ever leaves their own browser, so one visitor can never see another's data. The demo admin login only protects the visitor's own local data and is not a security boundary; that's why its credentials are shown on the page.

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | `3000`, `127.0.0.1` | Listen address |
| `NODE_ENV` | `development` | `production` enables HSTS, `Secure` cookies, HTTPS upgrade, mandatory secrets |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | `admin`, dev default | Admin credentials |
| `PII_ENCRYPTION_KEY`, `PII_HMAC_KEY` | auto-generated in `data/dev-keys.json` (dev only) | 32-byte base64 keys for AES-256-GCM and HMAC |
| `DATA_DIR`, `DB_FILE` | `./data`, `./data/bank-demo.db` | Storage location |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For` behind a known reverse proxy |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Host-header allow-list (DNS-rebinding defence); add your public hostname when deploying |
| `RATE_LIMIT_*` | see `server/config.js` | Rate limits |

---

## 2. Live demonstration script (about 10 minutes)

1. **First visit:** open the site in a private window with DevTools → Network open. The banner appears and **no request is made to `demo-analytics.js` or `demo-marketing.js`**, and no `_bcb_*` cookies exist. Navigating to another page does not count as consent; the banner stays.
2. **Reject optional:** the banner closes and a `bcb_consent` cookie stores the consent ID, timestamp and policy version. Reload: the choice is respected and still no optional scripts load.
3. **Granular choice:** click the cookie icon (bottom-left) or *Cookie settings* in the footer, turn on **Analytics only**, then *Save my choices*. `demo-analytics.js` loads immediately; marketing stays blocked. The Cookie Policy page's live panel shows this.
4. **Withdraw:** switch analytics off again. Its cookies are deleted and the page reloads so the script stops running.
5. **Server-side proof:** the dashboard's *Optional scripts: server-side evidence* tiles count events the API accepted. The API independently checks the stored consent and returns `403` without it, even for a forged cookie.
6. **Onboarding:** at *Open an Account*, fill in dummy details, then read the privacy notice. The required acknowledgement is **separate** from the optional consents, and the optional ones are **off by default**. Continuing without the acknowledgement is blocked. Review the choices, submit, and the confirmation page shows a reference number and the recorded consents with notice version and timestamp.
7. **Change of mind:** open *Manage my consents* from the confirmation page, withdraw marketing, and see it appear in the history.
8. **Dashboard:** sign in at `/admin/`. Show the counts, then search by exact email, mobile, name or reference, and filter by *Marketing = Withdrawn*. Open the customer to see consent history and audit trail; contact details are masked, and **Reveal** requires a reason, which is itself audited. Then show the cookie consents tab with per-visitor history, and the audit trail with **Verify integrity**.
9. **Robustness:** double-click *Submit*, or replay the same request: the idempotency key means the replay returns the original result and creates no duplicate. Submitting the same email or mobile again returns `409`.

---

## 3. Architecture

```
 Browser (bank website)                                Node.js server (single process, no deps)
 ┌───────────────────────────────────┐                 ┌───────────────────────────────────────────┐
 │ Pages (server-side includes)      │  GET pages      │ app.js     static files + templating,     │
 │  ├─ consent-manager.js (cookie SDK)│──────────────▶ │            security headers (strict CSP),  │
 │  │   blocks <script type=text/plain│                │            origin check, rate limiting,    │
 │  │   data-cmp-category=…>         │  POST /api/...  │            JSON error handling             │
 │  ├─ onboarding.js (3-step form)   │───────────────▶ │ routes.js  REST endpoints                 │
 │  ├─ manage-consent.js             │                 │ lib/validation.js  strict allow-lists     │
 │  └─ vendor/demo-*.js (blocked     │                 │ services/                                 │
 │      until consent)               │                 │   cookieConsents.js  customers.js         │
 └───────────────────────────────────┘                 │   audit.js (HMAC chain)  admin.js (auth)  │
 Browser (consent admin)                                │ lib/crypto.js  AES-256-GCM + HMAC index   │
 ┌───────────────────────────────────┐  /api/admin/*   │ db.js  SQLite (WAL, FKs, CHECKs,          │
 │ admin.js (tabs, filters, drawer)  │───────────────▶ │        append-only triggers)              │
 └───────────────────────────────────┘ HttpOnly session└───────────────────────────────────────────┘
```

**Single source of truth.** Policy versions, cookie categories and processing purposes are defined once in [server/config.js](server/config.js). The server injects them into the banner, preference centre, policy tables and onboarding form, and validates against them. The UI and the backend cannot drift apart.

**How optional scripts are blocked (the key test).** Optional scripts are written as `<script type="text/plain" data-cmp-category="analytics" data-cmp-src="…">`, and browsers never execute `text/plain`. The CMP creates a real `<script>` only after the server has **recorded** consent for that category. A strict Content-Security-Policy (`script-src 'self'`, no `unsafe-inline`) means no inline or third-party script can run outside this mechanism. The site loads no external fonts or CDNs, so nothing reaches a third party before consent. A banner alone is therefore not the control; the blocking is.

**Withdrawal never depends on the network.** Granting requires a successful server record. If the server is unreachable during a *withdrawal*, the restriction is applied locally at once and synced on the next visit.

**Re-consent.** The consent cookie stores the policy version and expires after 180 days. If the cookie policy version changes, visitors are asked again; stale submissions get `409 POLICY_VERSION_MISMATCH`. The same applies to the privacy notice (`NOTICE_VERSION_MISMATCH`).

---

## 4. Database structure (SQLite)

Schema: [server/db.js](server/db.js). All timestamps are ISO-8601 UTC.

| Table | Purpose | Key columns / constraints |
|---|---|---|
| `customers` | Onboarding applications | `id` (UUID), `reference_id` UNIQUE, `full_name_enc`, `email_enc`, `mobile_enc`, `dob_enc` (**AES-256-GCM**), `email_hash` UNIQUE, `mobile_hash` UNIQUE (**HMAC blind indexes**), `account_type`, `branch`, `manage_token_hash` (SHA-256 of the self-service token), `manage_token_expires_at` |
| `customer_consents` | **Current** state per customer and purpose | `UNIQUE(customer_id, purpose)`, `legal_basis` ∈ {necessary, consent}, `status` ∈ {acknowledged, granted, denied, withdrawn}, `notice_version`, `source`; CHECK: necessary ⇒ acknowledged, consent ⇒ granted/denied/withdrawn |
| `consent_events` | **Immutable history** of every consent transition | `previous_status`, `new_status`, `notice_version`, `source`, `created_at`; UPDATE/DELETE blocked by triggers |
| `cookie_consents` | Every cookie decision (latest row per visitor is active) | `visitor_id`, `analytics`, `marketing`, `necessary` CHECK = 1, `action` with CHECKs (accept_all ⇒ all 1, reject_optional ⇒ all 0), `policy_version`, `ip_hash` (HMAC, not the IP), truncated `user_agent`; UPDATE blocked |
| `audit_log` | Append-only, **HMAC hash-chained** audit trail | `actor_type`, `actor_id`, `action`, `entity_type`, `entity_id`, `details` (JSON, no raw PII), `prev_hash`, `hash`; UPDATE/DELETE blocked |
| `policy_versions` | Published cookie policy / privacy notice versions | `UNIQUE(policy_type, version)`, `content_hash` of the published text; warns if text changes without a version bump |
| `idempotency_keys` | Replay protection for onboarding | `PRIMARY KEY(scope, key)`, `request_hash`, encrypted stored response, 24h TTL |
| `telemetry_events` | Events from demo analytics/marketing scripts | Stored only when the visitor's recorded consent allows the category |
| `admin_sessions` | Admin sessions | SHA-256 of the token, idle (30 min) and absolute (8 h) expiry |

---

## 5. API endpoints

All responses are JSON. Errors have the shape `{ "error": { "code", "message", "details?" } }`. State-changing requests must be `application/json` from the same origin.

### Public

| Method & path | Description |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/consent-config` | Current policy versions, cookie categories, processing purposes, branches |
| `POST /api/cookie-consents` | Record a cookie decision. `201` new record, `200` duplicate de-duplicated, `422` invalid/inconsistent, `409` stale policy version |
| `POST /api/telemetry/:category` | Used by demo vendor scripts; `403 CONSENT_REQUIRED` unless the server-side record allows it |
| `POST /api/onboarding/applications` | Submit application + consents. **Requires `Idempotency-Key` header.** `201` created / replayed, `409 DUPLICATE_APPLICATION`, `409 NOTICE_VERSION_MISMATCH`, `422` validation / key reuse |
| `GET /api/self/consents` | Customer view of their consents & history (`Authorization: Bearer <token>`) |
| `PUT /api/self/consents` | Grant/withdraw optional consents (`Authorization: Bearer <token>`) |

Example:

```http
POST /api/onboarding/applications
Content-Type: application/json
Idempotency-Key: 6f0c8a4e-6a55-4a1b-9a8e-2b3f0e1d9c11

{
  "applicant": { "fullName": "Ritika Kumari", "email": "ritika@example.com", "mobile": "9876543210",
                 "dateOfBirth": "1994-06-18", "accountType": "savings", "branch": "gaya" },
  "acknowledgements": { "account_opening": true },
  "consents": { "marketing_communications": false, "third_party_sharing": false },
  "noticeVersion": "2026.10"
}
```

```http
POST /api/cookie-consents
Content-Type: application/json

{ "visitorId": null, "preferences": { "necessary": true, "analytics": true, "marketing": false },
  "action": "custom", "policyVersion": "1.0" }
```

### Admin (HttpOnly `SameSite=Strict` session cookie)

| Method & path | Description |
|---|---|
| `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me` | Session management (login throttled: 5 failures / 15 min) |
| `GET /api/admin/stats` | Counts: customers, consent records/events, status per purpose, cookie decisions, telemetry, audit entries |
| `GET /api/admin/customers?q=&purpose=&status=` | Search (exact email/mobile via blind index, reference prefix, name) and filter by consent status. PII masked |
| `GET /api/admin/customers/:id` | Customer detail, current consents, consent history, audit entries |
| `POST /api/admin/customers/:id/reveal` | Reveal full PII; **reason required and audited** |
| `GET /api/admin/cookie-consents?action=&category=&visitor=&history=all` | Cookie decisions (latest per visitor, or full history) |
| `GET /api/admin/cookie-consents/visitors/:visitorId` | One visitor's preference history + audit |
| `GET /api/admin/audit?action=&entityType=&limit=` | Audit trail |
| `GET /api/admin/audit/verify` | Recompute the HMAC chain and report tampering |
| `GET /api/admin/policies` | Published policy versions and content hashes |

---

## 6. How the requirements are met

### Validation and storage
* **Server-side allow-list validation** ([server/lib/validation.js](server/lib/validation.js)): unknown fields are rejected, types are strict (`"yes"` is not a boolean), enums apply for account type, branch, action and purpose. Names, email, Indian mobile numbers (normalised from `+91…`/`0…`) and real calendar dates are checked, and applicants must be 18+ (DPDP Act: minors need verifiable guardian consent, so they're routed to a branch).
* The client validates too, for usability; the server never trusts it.
* Every write runs in a single **`BEGIN IMMEDIATE` transaction**: customer, consents, events and audit rows commit together or not at all.

### Duplicate and inconsistent records are prevented
| Risk | Control |
|---|---|
| Double-click / network retry on submit | `Idempotency-Key`: the same key and body replays the original response; the same key with a different body gets `422` |
| Same person applying twice | `UNIQUE` HMAC blind index on normalised email and mobile → `409` |
| Two rows for one purpose | `UNIQUE(customer_id, purpose)`; changes update the row and append a `consent_events` row |
| Repeated identical cookie / consent saves | De-duplicated: no new row or event when nothing changed |
| "Accept all" with marketing off, necessary disabled, unknown purpose | `422` in validation **and** DB `CHECK` constraints as a second line |
| Consent against an outdated notice/policy | `409` version mismatch; client must show the current text |
| Changing the necessary purpose via the consent API | Rejected; only optional purposes can change |
| History rewritten | `consent_events`, `cookie_consents`, `audit_log` are append-only (triggers), audit is HMAC-chained |

### Sensitive data protection
* **Encryption at rest:** name, email, mobile and DOB use AES-256-GCM with a random IV per value. The record ID and field name are bound as AAD, so ciphertext cannot be swapped between rows. Keys are held outside the database.
* **Blind indexes** (HMAC-SHA256) enable uniqueness and exact search without plaintext.
* **Data minimisation:** visitors are pseudonymous (random UUID, HMAC of the IP, truncated user agent). No Aadhaar/PAN is collected.
* **Least exposure:** the admin sees masked email/mobile by default; full details need a stated reason and are audited (`PII_REVEALED`). Audit details never contain raw PII. Request logs contain only method, path, status and time: no bodies, query strings or headers.
* **Self-service token:** 256-bit random, stored only as a SHA-256 hash, expires after 30 days, carried in the URL **fragment** (never sent in server logs or the Referer header), sent to the API as a Bearer header, and **removed from the address bar** as soon as the page reads it (kept only in that tab's `sessionStorage`).
* **Web security:** strict CSP (no inline scripts or styles, `frame-ancestors 'none'`), `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP, and HSTS in production. Same-origin check on all writes. Admin cookie is `HttpOnly; SameSite=Strict; Path=/api/admin` (+`Secure` in production). The password is held only as a salted scrypt hash and compared in constant time. Per-IP rate limits. 16 KB body limit. Path-traversal-safe static serving (also blocks `:` for Windows alternate data streams). The admin UI renders data with `textContent` only (no XSS sink).
* **Trusted Types:** the CSP enforces `require-trusted-types-for 'script'`. The only way any script URL can be created is the consent manager's `bcb-cmp` policy, which accepts only same-origin files in `/assets/js/vendor/`. An attacker-injected `<script type="text/plain" data-cmp-src="https://evil…">` is never loaded, even after consent (covered by the browser test).
* **DNS rebinding:** requests whose `Host` header is not in `ALLOWED_HOSTS` get `421` before reaching the app. The server also refuses to bind to a non-loopback address while the development admin password is in use.

### Bot protection (privacy-friendly CAPTCHA)
Account opening and admin sign-in are protected by a **self-hosted proof-of-work CAPTCHA** ([server/lib/captcha.js](server/lib/captcha.js), [public/assets/js/captcha.js](public/assets/js/captcha.js)). It uses the same protocol idea as ALTCHA and Friendly Captcha:
* The server issues a challenge `SHA-256(salt + secret number)`, signed with HMAC and bound to a purpose (`onboarding` / `admin_login`) with a 10-minute expiry. The browser finds the number with Web Crypto in about a second, automatically.
* The server verifies the signature, hash, purpose and expiry, and stores the challenge so **each solution works only once**. Missing, forged, tampered, reused or wrong-purpose solutions get `403`.
* An idempotent retry of an already-processed application replays the original result without a new CAPTCHA, so a network retry never fails or duplicates.
* **Why not Google reCAPTCHA or hCaptcha:** they load third-party scripts and set tracking cookies before the visitor has consented, which would contradict the cookie-consent guarantees of this site. They also need a server-side secret that a static host cannot hold. This approach has no third parties, no cookies, no tracking and no image puzzles (accessible), and works on GitHub Pages too.
* Not applied to the cookie banner (a privacy choice must never be obstructed) or to self-service consent changes (already protected by a secret 256-bit token).

---

## 7. Deployment and integration into a customer's environment

```
             ┌──────────── Bank DMZ ────────────┐        ┌──── Consent platform (SaaS or bank-hosted) ────┐
 Customer ─▶ │ WAF / CDN ─▶ Bank website        │        │ API gateway (mTLS / OAuth2 client credentials) │
             │   <script src=".../consent-      │─HTTPS─▶│  ├─ Consent API (stateless, horizontally scaled)│
             │    manager.js" data-tenant=bcb>  │        │  ├─ Cookie consent API                          │
             │ Onboarding service ──────────────┼─server─▶│  ├─ Admin UI (SSO: SAML/OIDC + MFA, RBAC)      │
             └──────────────────────────────────┘ to     │  ├─ PostgreSQL (encrypted, PITR, replicas)     │
 Core banking / CRM / marketing ◀── webhooks / events ───│  ├─ KMS/HSM for keys · SIEM for audit export   │
   (suppress marketing when consent withdrawn)           │  └─ Event bus: consent.granted / withdrawn      │
                                                         └─────────────────────────────────────────────────┘
```

* **Cookie module:** a script-tag SDK. The bank marks optional tags with `type="text/plain" data-cmp-category=…` (or registers them in a tag manager that waits for the CMP's consent signal). Categories and cookie inventories come from the consent platform's configuration, ideally kept current by an automated cookie scanner.
* **Consent module:** the bank's onboarding backend calls the Consent API **server-to-server** (authenticated, idempotent). The browser never talks to the consent platform directly with customer PII.
* **Downstream enforcement:** consent changes are published as events/webhooks, so CRM and marketing systems suppress customers within minutes of withdrawal. Systems can also query `GET consent status` before each campaign.
* **Hosting:** containerised (stateless app + managed PostgreSQL). It can be deployed in the bank's own data centre or an Indian cloud region for data-localisation requirements. Environments are separated (dev/UAT/prod) with infrastructure as code.

## 8. Changes required before deployment in a real bank

1. **Identity & authentication:** OTP/verified email for the self-service link (or authenticate through net-banking); bank SSO with MFA and role-based access (viewer / DPO / admin) for the dashboard; maker-checker for sensitive actions.
2. **Database:** PostgreSQL with migrations, backups, point-in-time recovery, row-level security per tenant; WORM/immutable storage or SIEM export for the audit trail.
3. **Key management:** keys in an HSM/KMS with rotation (the ciphertext already carries a key ID, `k1`, for this) and envelope encryption; secrets come from a vault, never env files.
4. **Search at scale:** replace in-memory name search with a tokenised or searchable-encryption index.
5. **Legal & content:** DPO/legal review of notices for the DPDP Act 2023 and Rules, RBI and cooperative-bank guidelines; notices in Hindi and English (DPDP requires a choice of scheduled languages); retention schedules with automated deletion; data-principal request workflows (access, correction, erasure, nomination, grievance SLAs); integration with Consent Managers registered with the Data Protection Board where applicable.
6. **Real KYC:** CKYC/video-KYC integration, document verification, AML screening; this demo intentionally collects none of that.
7. **Security assurance:** VAPT, secure code review, CERT-In-compliant logging and incident reporting, a WAF, DDoS protection, a distributed rate limiter (Redis), dependency and container scanning, and CSP reporting.
8. **Operations:** health checks, metrics, alerting, log aggregation, HA deployment, DR drills, and change management aligned with the bank's ITSM.
9. **Cookie governance:** an automated scanner to detect undeclared cookies or tags, plus regular reviews of the cookie inventory and policy versions.
10. **Accessibility & QA:** a WCAG 2.1 AA audit, cross-browser/device testing, and load testing.

---

## 9. Tests

* `npm test` ([tests/api.test.js](tests/api.test.js)): 35 tests against an isolated temporary database. They cover security headers, CSP and Trusted Types; script blocking in the served HTML; path traversal and Windows path tricks; Host-header (DNS-rebinding) rejection; the CAPTCHA (missing, reused, wrong purpose, tampered, forged); cookie consent validation, consistency, versioning and de-duplication; server-side refusal of telemetry without consent (including forged cookies); onboarding validation; separate acknowledgement; marketing not required; idempotency replay and key reuse; duplicate email/mobile; encryption at rest; self-service withdrawal and history; admin authentication; masking; filters; audited PII reveal; append-only tables; and tamper detection on the audit chain.
* `npm run test:e2e` ([tests/e2e-browser.js](tests/e2e-browser.js)): drives headless Chrome or Edge over the DevTools protocol with no dependencies. It watches real network requests to prove optional scripts never load before consent and that injected foreign scripts never load at all. It covers the full onboarding (including the CAPTCHA) → self-service → admin journey, removal of the token from the address bar, refusal to render inside a frame, mobile layout at 375px (no horizontal scroll), and zero console errors or CSP violations. Set `SCREENSHOT_DIR` to capture screenshots.

## 10. Project structure

```
server/
  index.js            entry point
  app.js              HTTP server, static files, templating, security headers, error handling
  routes.js           API routes
  config.js           policy versions, cookie categories, purposes, limits
  db.js               SQLite schema, constraints, triggers, transactions
  lib/                crypto (AES-GCM, HMAC), http helpers, router, rate limiter, validation
  services/           cookie consents, customers & consents, audit chain, admin auth & stats
public/
  *.html              bank website pages (partials/ = shared header & footer with CMP)
  admin/index.html    consent admin dashboard
  assets/js/          consent-manager.js, captcha.js, onboarding.js, manage-consent.js, admin.js, vendor/ (blocked demo scripts)
  assets/css/         site.css, admin.css
scripts/              seed.js, reset.js, build-static.js, serve-static.js
static-demo/          mock-api.js (in-browser API), frame-guard.js (clickjacking guard), used only by the GitHub Pages build
docs/                 generated static site for GitHub Pages (npm run build:static)
tests/                api.test.js, e2e-browser.js
```
