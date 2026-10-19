'use strict';

/**
 * Local preview of the GitHub Pages build. Serves ./docs under a sub-path
 * (default /bank-privacy-demo/) exactly like https://<user>.github.io/<repo>/.
 *   npm run build:static && npm run preview:static
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const BASE = `/${(process.env.BASE_PATH || 'bank-privacy-demo').replace(/^\/|\/$/g, '')}/`;
const PORT = parseInt(process.env.PORT || '4000', 10);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  let file = path.resolve(ROOT, `.${decodeURIComponent(url.pathname.slice(BASE.length - 1))}`);
  if (!file.startsWith(ROOT)) file = null;
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': MIME['.html'] });
    return res.end(fs.readFileSync(path.join(ROOT, '404.html')));
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(fs.readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log(`Static preview: http://127.0.0.1:${PORT}${BASE}`));
