'use strict';

/**
 * End-to-end browser test (no dependencies). Drives headless Chrome/Edge via the
 * DevTools protocol and verifies the complete customer journey, including the key
 * requirement: optional scripts never load before the relevant consent.
 *
 *   npm start            (in another terminal)
 *   npm run test:e2e     (optional: BASE_URL, BROWSER, SCREENSHOT_DIR, ADMIN_PASSWORD)
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const SHOTS = process.env.SCREENSHOT_DIR || null;
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'BankDemo@2026';
const DEBUG_PORT = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chrome/Edge found. Set BROWSER=/path/to/chrome');
  return found;
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method) {
        this.handlers.slice().forEach((h) => h(msg));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(fn) { this.handlers.push(fn); }

  waitFor(method, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeout);
      const handler = (msg) => {
        if (msg.method !== method) return;
        clearTimeout(timer);
        this.handlers = this.handlers.filter((h) => h !== handler);
        resolve(msg.params);
      };
      this.on(handler);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`Eval failed: ${(r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text}`);
    return r.result.value;
  }

  async goto(url) {
    const loaded = this.waitFor('Page.loadEventFired');
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(400);
  }

  async waitUntil(expression, timeout = 6000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.eval(expression)) return true;
      await sleep(100);
    }
    throw new Error(`Condition not met within ${timeout}ms: ${expression}`);
  }

  async viewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }

  async screenshot(name, full = false) {
    if (!SHOTS) return;
    const params = { format: 'png' };
    if (full) {
      const m = await this.send('Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: m.cssContentSize.width, height: Math.min(m.cssContentSize.height, 6000), scale: 1 };
    }
    const r = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  }
}

let failures = 0;
function check(name, condition, info) {
  if (condition) console.log(`  \u2714 ${name}`);
  else { failures += 1; console.log(`  \u2718 ${name}${info !== undefined ? ` (${JSON.stringify(info)})` : ''}`); }
}

async function main() {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-e2e-'));
  const browser = spawn(findBrowser(), [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank',
  ], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 50 && !target; i += 1) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch { /* browser still starting */ }
  }
  if (!target) throw new Error('Could not connect to the browser');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const page = new Page(ws);

  const requests = [];
  const problems = [];
  page.on((msg) => {
    if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
    if (msg.method === 'Runtime.exceptionThrown') problems.push(msg.params.exceptionDetails.exception ? msg.params.exceptionDetails.exception.description : msg.params.exceptionDetails.text);
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/status of 4\d\d/.test(msg.params.entry.text)) problems.push(msg.params.entry.text);
  });
  await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'].map((m) => page.send(m)));
  await page.send('Network.clearBrowserCookies');
  await page.viewport(1366, 900);

  const loadedVendor = (name) => requests.some((u) => u.includes(`/vendor/demo-${name}.js`));
  const cookieNames = () => page.eval("document.cookie.split('; ').filter(Boolean).map(c => c.split('=')[0])");
  const consentCookie = () => page.eval("(() => { const m = document.cookie.match(/(?:^|; )bcb_consent=([^;]*)/); return m ? JSON.parse(decodeURIComponent(m[1])) : null; })()");
  const click = (selector) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector.replace(/'/g, '')}'); el.click(); return true; })()`);

  // ---------------------------------------------------------------- cookies
  console.log('\nCookie management');
  requests.length = 0;
  await page.goto(`${BASE}/`);
  await page.screenshot('01-home-first-visit', true);
  check('banner is shown on first visit', await page.eval("!document.getElementById('cmp-banner').hidden"));
  check('analytics script NOT requested before consent', !loadedVendor('analytics'));
  check('marketing script NOT requested before consent', !loadedVendor('marketing'));
  check('no optional cookies before consent', (await cookieNames()).every((n) => !n.startsWith('_bcb_')), await cookieNames());
  check('no third-party requests at all', requests.every((u) => u.startsWith(BASE) || u.startsWith('data:')), requests.filter((u) => !u.startsWith(BASE)));

  await page.goto(`${BASE}/about.html`);
  check('banner still shown while no decision is made (navigating is not consent)', await page.eval("!document.getElementById('cmp-banner').hidden"));
  check('still no optional scripts after navigation', !loadedVendor('analytics') && !loadedVendor('marketing'));

  await click('#cmp-banner [data-cmp-action="reject_optional"]');
  await page.waitUntil("document.getElementById('cmp-banner').hidden");
  let c = await consentCookie();
  check('Reject optional stores consent cookie with analytics=0, marketing=0', c && c.a === 0 && c.m === 0, c);
  check('consent cookie has id, timestamp and policy version', c && c.id && c.ts && c.v === '1.0', c);
  requests.length = 0;
  await page.goto(`${BASE}/`);
  check('choice respected on next visit: banner hidden', await page.eval("document.getElementById('cmp-banner').hidden"));
  check('choice respected on next visit: no optional scripts', !loadedVendor('analytics') && !loadedVendor('marketing'));
  check('cookie-settings button is available to reopen preferences', await page.eval("!document.getElementById('cmp-fab').hidden"));

  await click('footer [data-cmp-open]');
  await page.waitUntil("!document.getElementById('cmp-overlay').hidden");
  check('preference centre opens with optional toggles OFF', await page.eval("[...document.querySelectorAll('[data-cmp-toggle]')].every(t => !t.checked)"));
  check('strictly necessary shown as always active', await page.eval("document.querySelector('.cmp-always') !== null"));
  await page.eval("document.querySelector('[data-cmp-toggle=\"analytics\"]').click()");
  await page.screenshot('02-preference-centre');
  await click('#cmp-overlay [data-cmp-action="custom"]');
  await page.waitUntil('window.__bcbScripts && window.__bcbScripts.analytics === true');
  check('analytics script loads immediately after analytics consent', loadedVendor('analytics'));
  check('marketing script still blocked (granular choice)', !loadedVendor('marketing'));
  await sleep(400);
  check('analytics cookies set only after consent', (await cookieNames()).includes('_bcb_an_id'), await cookieNames());

  requests.length = 0;
  await page.goto(`${BASE}/cookie-policy.html`);
  await page.waitUntil('window.__bcbScripts && window.__bcbScripts.analytics === true');
  check('analytics consent respected on subsequent visit', loadedVendor('analytics') && !loadedVendor('marketing'));
  await sleep(2200);
  check('cookie policy live panel reports analytics running, marketing blocked',
    await page.eval("document.querySelector('[data-status=\"analytics-script\"]').textContent.startsWith('Loaded') && document.querySelector('[data-status=\"marketing-script\"]').textContent.startsWith('Blocked')"));
  await page.screenshot('03-cookie-policy-status', true);

  // Withdraw analytics -> cookies deleted and page reloaded so the script stops.
  await click('#consent-status [data-cmp-open]');
  await page.waitUntil("!document.getElementById('cmp-overlay').hidden");
  await page.eval("document.querySelector('[data-cmp-toggle=\"analytics\"]').click()");
  requests.length = 0;
  const reloaded = page.waitFor('Page.loadEventFired');
  await click('#cmp-overlay [data-cmp-action="custom"]');
  await reloaded;
  await sleep(600);
  check('withdrawal reloads page and analytics no longer runs', !loadedVendor('analytics') && !(await page.eval('!!(window.__bcbScripts && window.__bcbScripts.analytics)')));
  check('analytics cookies deleted on withdrawal', !(await cookieNames()).some((n) => n.startsWith('_bcb_an')), await cookieNames());

  await click('#cmp-fab');
  await page.waitUntil("!document.getElementById('cmp-overlay').hidden");
  requests.length = 0;
  // Simulate an attacker-injected blocked tag pointing at a foreign script.
  await page.eval("(() => { const s = document.createElement('script'); s.type = 'text/plain'; s.setAttribute('data-cmp-category', 'analytics'); s.setAttribute('data-cmp-src', 'https://attacker.example/steal.js'); document.body.appendChild(s); })()");
  await click('#cmp-overlay [data-cmp-action="accept_all"]');
  await page.waitUntil('window.__bcbScripts && window.__bcbScripts.analytics && window.__bcbScripts.marketing');
  check('Accept all loads analytics and marketing', loadedVendor('analytics') && loadedVendor('marketing'));
  check('injected foreign script is never loaded, even after consent', !requests.some((u) => u.includes('attacker.example')));
  problems.splice(0, problems.length, ...problems.filter((p) => !/unapproved script URL/.test(p)));
  const visitorId = (await consentCookie()).vid;

  // --------------------------------------------------------------- onboarding
  console.log('\nCustomer onboarding consent');
  const unique = String(Date.now()).slice(-8);
  const email = `e2e.${unique}@example.com`;
  const mobile = `9${unique}1`.slice(0, 10);
  await page.goto(`${BASE}/open-account.html`);
  await page.screenshot('04-onboarding-step1');
  await click('[data-step-panel="1"] [data-next="2"]');
  check('step 1 blocks empty submission with errors', await page.eval("!document.getElementById('error-summary').hidden && !document.querySelector('[data-step-panel=\"1\"]').hidden"));
  await page.eval(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('fullName', 'Ritika Kumari'); set('email', ${JSON.stringify(email)}); set('mobile', ${JSON.stringify(mobile)});
    set('dateOfBirth', '1994-06-18'); set('accountType', 'savings'); set('branch', 'gaya');
  })()`);
  await click('[data-step-panel="1"] [data-next="2"]');
  check('step 2 shows privacy notice', await page.eval("!document.querySelector('[data-step-panel=\"2\"]').hidden && document.querySelector('.notice-box').textContent.includes('version 2026.10')"));
  check('optional consents are NOT preselected', await page.eval("[...document.querySelectorAll('[data-consent]')].every(t => !t.checked)"));
  check('required acknowledgement is separate from optional consents', await page.eval("document.querySelector('#required-group [data-ack]') !== null && document.querySelector('#required-group [data-consent]') === null && document.querySelectorAll('#optional-group [data-consent]').length === 2"));
  await page.screenshot('05-onboarding-step2', true);
  await click('[data-step-panel="2"] [data-next="3"]');
  check('cannot continue without the required acknowledgement', await page.eval("!document.querySelector('[data-step-panel=\"2\"]').hidden && !document.getElementById('error-summary').hidden"));
  await page.eval("document.querySelector('[data-ack=\"account_opening\"]').click(); document.querySelector('[data-consent=\"marketing_communications\"]').click();");
  await click('[data-step-panel="2"] [data-next="3"]');
  check('review step lists details and choices', await page.eval("!document.querySelector('[data-step-panel=\"3\"]').hidden && document.getElementById('review-details').textContent.includes('Ritika Kumari') && document.getElementById('review-consents').textContent.includes('Consent given') && document.getElementById('review-consents').textContent.includes('Not given')"));
  await page.screenshot('06-onboarding-review', true);
  await page.waitUntil("document.querySelector('.captcha-box').getAttribute('data-state') === 'done'", 30000);
  check('human verification (proof-of-work CAPTCHA) completes automatically', true);
  await click('#submit-btn');
  await page.waitUntil("!document.querySelector('[data-step-panel=\"4\"]').hidden", 20000);
  const ref = await page.eval("document.getElementById('conf-ref').textContent");
  check('confirmation screen shows reference', /^BCB-\d{4}-[A-Z0-9]{6}$/.test(ref), ref);
  check('confirmation lists recorded consents with notice version', await page.eval("document.querySelectorAll('#conf-consents tr').length === 3 && document.getElementById('conf-consents').textContent.includes('2026.10')"));
  await page.screenshot('07-onboarding-confirmation', true);
  const manageUrl = await page.eval("document.getElementById('conf-manage').href");

  console.log('\nCustomer self-service');
  await page.goto(manageUrl);
  await page.waitUntil("!document.getElementById('mc-panel').hidden");
  check('manage page shows current consents', await page.eval("document.getElementById('mc-marketing_communications').checked === true && document.getElementById('mc-third_party_sharing').checked === false"));
  await page.eval("document.getElementById('mc-marketing_communications').click()");
  await click('#mc-save');
  await page.waitUntil("!document.getElementById('mc-success').hidden");
  check('withdrawal saved and shown in history', await page.eval("document.getElementById('mc-success').textContent.includes('withdrawn') && document.getElementById('mc-history').textContent.includes('Withdrawn')"));
  check('consent token is removed from the address bar', !(await page.eval('location.href')).includes('token='));
  await page.screenshot('08-manage-consent', true);

  // -------------------------------------------------------------------- admin
  console.log('\nConsent admin dashboard');
  await page.goto(`${BASE}/admin/`);
  await page.waitUntil("!document.getElementById('login-view').hidden");
  await page.eval(`document.getElementById('login-username').value = ${JSON.stringify(ADMIN_USER)}; document.getElementById('login-password').value = ${JSON.stringify(ADMIN_PASS)};`);
  await click('#login-btn');
  await page.waitUntil("!document.getElementById('app-view').hidden && document.querySelectorAll('#kpis .kpi').length === 5", 30000);
  check('overview shows KPI counts and purpose bars', await page.eval("document.querySelectorAll('#purpose-bars .purpose-row').length === 3"));
  await page.screenshot('09-admin-overview', true);

  await click('[data-tab="customers"]');
  await page.eval(`document.getElementById('cf-q').value = ${JSON.stringify(email)}`);
  await click('#customer-filters [type="submit"]');
  await page.waitUntil(`document.getElementById('customer-rows').textContent.includes(${JSON.stringify(ref)})`);
  check('customer search by email finds the new application', true);
  await click('#customer-rows tr');
  await page.waitUntil("!document.getElementById('drawer').hidden && document.querySelector('.timeline li') !== null");
  check('customer detail shows consent history with withdrawal', await page.eval("document.querySelector('.timeline').textContent.includes('Withdrawn')"));
  await page.screenshot('10-admin-customer-detail');
  await click('#drawer-close');

  await page.eval("document.getElementById('cf-q').value = ''; document.getElementById('cf-purpose').value = 'marketing_communications'; document.getElementById('cf-status').value = 'withdrawn';");
  await click('#customer-filters [type="submit"]');
  await page.waitUntil(`document.getElementById('customer-rows').textContent.includes(${JSON.stringify(ref)})`);
  check('filter by consent status (marketing withdrawn) includes the customer', true);

  await click('[data-tab="cookies"]');
  await page.eval(`document.getElementById('kf-visitor').value = ${JSON.stringify(visitorId.slice(0, 8))}`);
  await click('#cookie-filters [type="submit"]');
  await page.waitUntil("document.querySelectorAll('#cookie-rows tr').length === 1 && document.getElementById('cookie-rows').textContent.includes('Accept all')");
  check('cookie consents tab shows this browser’s latest decision', true);
  await click('#cookie-rows tr');
  await page.waitUntil("!document.getElementById('drawer').hidden");
  check('visitor history shows all 4 decisions', await page.eval("document.querySelectorAll('#drawer-body tbody')[0].children.length === 4"));
  await click('#drawer-close');

  await click('[data-tab="audit"]');
  await page.waitUntil("document.querySelectorAll('#audit-rows tr').length > 5");
  await click('#verify-btn');
  await page.waitUntil("!document.getElementById('verify-result').hidden");
  check('audit integrity verification passes', await page.eval("document.getElementById('verify-result').textContent.startsWith('Integrity verified')"));
  await page.screenshot('11-admin-audit');

  // ------------------------------------------------------------- responsive
  console.log('\nResponsive layout (375px)');
  await page.viewport(375, 812, true);
  for (const p of ['/', '/open-account.html', '/cookie-policy.html', '/contact.html', '/admin/']) {
    await page.goto(BASE + p);
    const overflow = await page.eval('document.documentElement.scrollWidth - window.innerWidth');
    check(`no horizontal scroll on ${p}`, overflow <= 0, overflow);
  }
  await page.goto(`${BASE}/`);
  await page.screenshot('12-mobile-home');
  await click('.nav-toggle');
  check('mobile menu opens', await page.eval("document.getElementById('main-nav').classList.contains('open')"));
  await page.screenshot('13-mobile-menu');

  console.log('\nBrowser console');
  check('no JavaScript errors or CSP violations', problems.length === 0, problems);

  console.log('\nClickjacking');
  await page.viewport(1366, 900);
  await page.goto(`${BASE}/support.html`);
  await page.eval(`(() => { const f = document.createElement('iframe'); f.id = 'cj'; f.src = ${JSON.stringify(`${BASE}/admin/`)}; f.width = 800; f.height = 600; document.body.appendChild(f); })()`);
  await sleep(2500);
  const framedRendered = await page.eval(`(() => {
    const f = document.getElementById('cj');
    if (!f) return false; // the guard navigated the top window away: framing defeated
    try { const d = f.contentDocument; return !!(d && d.querySelector('#login-form') && !d.documentElement.hidden && !/cannot be displayed/.test(d.body.textContent)); }
    catch (e) { return false; }
  })()`).catch(() => false);
  check('site refuses to render inside a frame', !framedRendered);

  ws.close();
  browser.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* profile may be locked briefly */ }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll browser checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
