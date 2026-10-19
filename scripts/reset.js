'use strict';

/** Deletes the local demo database (keeps the development encryption keys). */
const fs = require('node:fs');
const config = require('../server/config');

for (const suffix of ['', '-wal', '-shm']) {
  const file = config.dbFile + suffix;
  if (fs.existsSync(file)) {
    fs.rmSync(file);
    console.log(`Removed ${file}`);
  }
}
console.log('Database reset. Run "npm start" (and optionally "npm run seed").');
