#!/usr/bin/env node
'use strict';
// Serves the SYNTHETIC test websites in fixtures/sites/<host>/ at
// http://127.0.0.1:<port>/<host>/<path>. Workflows rewrite *.example URLs to
// this server when settings.fixture_base_url is set. Test use only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'fixtures', 'sites');

function fileFor(host, urlPath) {
  const p = urlPath.split('?')[0].replace(/^\/+|\/+$/g, '');
  if (p === 'robots.txt') return path.join(ROOT, host, 'robots.txt');
  return path.join(ROOT, host, (p === '' ? 'index' : p.replace(/\//g, '_')) + '.html');
}

function createServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const [, host, ...rest] = req.url.split('/');
    const urlPath = '/' + rest.join('/');
    requests.push({ host, path: urlPath, ua: req.headers['user-agent'] || '' });
    const siteDir = path.join(ROOT, host || '');
    if (!host || !host.endsWith('.example') || host.includes('..') || !fs.existsSync(siteDir)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('no such synthetic site');
    }
    let override = {};
    const statusFile = path.join(siteDir, '_status.json');
    if (fs.existsSync(statusFile)) override = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const forced = override[urlPath] || override['*'];
    if (forced && !urlPath.startsWith('/robots.txt')) {
      res.writeHead(forced, { 'content-type': 'text/html' });
      return res.end('<html><body>Access Denied</body></html>');
    }
    const file = fileFor(host, urlPath);
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<html><body>Not found</body></html>');
    }
    res.writeHead(200, { 'content-type': file.endsWith('.txt') ? 'text/plain' : 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(file));
  });
  server.requests = requests;
  return server;
}

if (require.main === module) {
  const port = Number(process.env.FIXTURE_PORT || 8787);
  createServer().listen(port, '127.0.0.1', () => console.log(`fixture sites on http://127.0.0.1:${port}/<host>/`));
}

module.exports = { createServer };
