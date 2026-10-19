'use strict';

const config = require('./config');
const { createApp } = require('./app');

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
if (!LOOPBACK.includes(config.host) && config.admin.usingDevPassword) {
  console.error(`Refusing to listen on ${config.host} with the development admin password. Set ADMIN_PASSWORD (and ALLOWED_HOSTS) first.`);
  process.exit(1);
}

const { server } = createApp();

server.listen(config.port, config.host, () => {
  const base = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log('');
  console.log('  Bihar Cooperative Bank (demo) + consent management platform');
  console.log(`  Website:          ${base}/`);
  console.log(`  Account opening:  ${base}/open-account.html`);
  console.log(`  Consent admin:    ${base}/admin/`);
  if (config.admin.usingDevPassword) {
    console.log(`  Admin login:      ${config.admin.username} / ${config.admin.password}  (development default; set ADMIN_PASSWORD)`);
  }
  console.log(`  Database:         ${config.dbFile}`);
  console.log('');
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
