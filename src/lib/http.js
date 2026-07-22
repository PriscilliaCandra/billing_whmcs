'use strict';
// Minimal HTTP helpers: cookie parsing, body parsing, static file serving.
const fs = require('node:fs');
const path = require('node:path');

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

// Parse application/x-www-form-urlencoded (storefront/admin forms) ATAU
// application/json (dipakai API server-to-server, mis. sinkron invoice CRM →
// Billing) bodies. Repeated keys dan key[] arrays tetap didukung utk urlencoded.
function parseBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST' && req.method !== 'PUT') return resolve({});
    const isJson = (req.headers['content-type'] || '').includes('application/json');
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return resolve({});
      if (isJson) {
        try { return resolve(data ? JSON.parse(data) : {}); }
        catch { return resolve({}); }
      }
      resolve(parseUrlEncoded(data));
    });
    req.on('error', () => resolve({}));
  });
}

function parseUrlEncoded(str) {
  const out = {};
  if (!str) return out;
  const params = new URLSearchParams(str);
  for (const [key, value] of params.entries()) {
    if (key.endsWith('[]')) {
      const k = key.slice(0, -2);
      if (!Array.isArray(out[k])) out[k] = [];
      out[k].push(value);
    } else if (key in out) {
      if (!Array.isArray(out[key])) out[key] = [out[key]];
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function serveStatic(publicDir, urlPath, res) {
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(publicDir, safe);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
    return true;
  }
  return false;
}

module.exports = { parseCookies, parseBody, parseUrlEncoded, serveStatic };
