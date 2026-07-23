'use strict';
// SahabatAI Billing — Node server (node:http + PostgreSQL/pg).
const http = require('node:http');
const path = require('node:path');
// === FIX GAP KONFIGURASI === muat .env SEBELUM modul lain (mis. db.js) baca
// process.env — sebelumnya server ini tak pernah memuat .env sama sekali (lihat
// src/lib/loadEnv.js). WAJIB baris pertama setelah require inti node.
require('./src/lib/loadEnv').loadEnvFile();
const { get, run } = require('./src/db');
const { ensureSchema, seed } = require('./src/schema');
const { parseCookies, parseBody, serveStatic } = require('./src/lib/http');
const { randomId } = require('./src/lib/crypto');
const { Router } = require('./src/lib/router');

const PORT = process.env.PORT || 3400;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'sbsid';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

// --- Session store (PostgreSQL-backed) — async ---
async function loadSession(sid) {
  if (!sid) return null;
  const row = await get('SELECT data, expires FROM sessions WHERE sid = ?', sid);
  if (!row) return null;
  if (row.expires < Date.now()) {
    await run('DELETE FROM sessions WHERE sid = ?', sid);
    return null;
  }
  try { return JSON.parse(row.data); } catch { return {}; }
}
async function saveSession(sid, data) {
  const expires = Date.now() + SESSION_TTL;
  const json = JSON.stringify(data || {});
  // PostgreSQL upsert.
  await run(
    `INSERT INTO sessions (sid, data, expires) VALUES (?,?,?)
     ON CONFLICT (sid) DO UPDATE SET data = EXCLUDED.data, expires = EXCLUDED.expires`,
    sid, json, expires
  );
}

// --- Router setup ---
const router = new Router();
require('./routes/admin')(router);
require('./routes/client')(router);
require('./routes/api')(router); // === API SINKRON INVOICE (dari OmsetAI CRM) ===

// --- Request context ---
function makeCtx(req, res, params) {
  const ctx = {
    req, res, params,
    query: {}, body: {}, session: {}, sid: null,
    admin: null, client: null,
    status(code) { res.statusCode = code; return ctx; },
    // CATATAN: session TIDAK lagi disimpan di sini. Karena saveSession kini async
    // (MySQL), persist dilakukan SEKALI di akhir request (blok finally di handler
    // di bawah) agar html/send/redirect tetap sinkron & tak perlu di-await.
    html(str) {
      res.writeHead(res.statusCode || 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(str);
    },
    send(str, type = 'text/plain; charset=utf-8') {
      res.writeHead(res.statusCode || 200, { 'Content-Type': type });
      res.end(str);
    },
    redirect(location) {
      res.writeHead(302, { Location: location });
      res.end();
    },
    notFound(msg = 'Halaman tidak ditemukan') {
      res.statusCode = 404;
      ctx.html(`<div style="font-family:sans-serif;padding:3rem;text-align:center"><h1>404</h1><p>${msg}</p><a href="/">Beranda</a></div>`);
    },
    flash(type, msg) { ctx.session.flash = { type, msg }; },
  };
  return ctx;
}

const server = http.createServer(async (req, res) => {
  // ctx dideklarasi di scope fungsi agar bisa dilihat blok finally (persist session).
  let ctx = null;
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // Static files
    if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.startsWith('/img/') || pathname === '/favicon.ico') {
      if (serveStatic(PUBLIC_DIR, pathname, res)) return;
      res.statusCode = 404; res.end('Not found'); return;
    }

    const matched = router.match(req.method, pathname);
    ctx = makeCtx(req, res, matched ? matched.params : {});

    // Session
    const cookies = parseCookies(req);
    let sid = cookies[SESSION_COOKIE];
    let session = sid ? await loadSession(sid) : null;
    if (!sid || !session) {
      sid = randomId(18);
      session = {};
      // Behind a TLS-terminating reverse proxy (production), mark the cookie Secure so
      // it's never sent over plain HTTP. Trust X-Forwarded-Proto only when TRUST_PROXY=true
      // is set (i.e. the deployer has confirmed a proxy sits in front and sets that header).
      const isHttps = req.socket.encrypted
        || (process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] === 'https');
      const secureFlag = isHttps ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secureFlag}`);
    }
    ctx.sid = sid;
    ctx.session = session;

    // Query + body
    ctx.query = Object.fromEntries(url.searchParams.entries());
    ctx.body = await parseBody(req);

    if (!matched) return ctx.notFound();

    // Run handler chain (middleware may set res and stop by returning false-y via responded flag)
    for (const handler of matched.handlers) {
      const result = await handler(ctx);
      if (result === 'STOP' || res.writableEnded) break;
    }
    if (!res.writableEnded) ctx.notFound();
  } catch (err) {
    console.error('Request error:', err);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('<h1>500 — Server Error</h1><pre>' + String(err && err.stack || err) + '</pre>');
    }
  } finally {
    // Persist session SEKALI di akhir request (menggantikan persist() sinkron yang
    // dulu ada di ctx.html/send/redirect). Aman walau response sudah terkirim:
    // data sesi hanya perlu tersimpan sebelum request BERIKUTNYA dari user.
    if (ctx && ctx.sid) {
      try { await saveSession(ctx.sid, ctx.session); }
      catch (e) { console.error('Session save failed:', e.message); }
    }
  }
});

// --- Boot: ensure schema + seed on first run, LALU nyalakan server ---
// CommonJS tidak punya top-level await, jadi dibungkus async main().
async function main() {
  await ensureSchema();
  if (!await get('SELECT id FROM admins LIMIT 1')) {
    console.log('Empty database detected — seeding demo data...');
    await seed();
  }
  server.listen(PORT, () => {
    console.log('\n  SahabatAI Billing berjalan di:');
    console.log(`  → Storefront : http://localhost:${PORT}/`);
    console.log(`  → Admin      : http://localhost:${PORT}/admin/login`);
    console.log('\n  Login admin  : musa / Tobethebest123#');
    console.log('  Login klien  : demo@client.com / demo123\n');
  });
}

main().catch((err) => {
  console.error('Boot gagal:', err);
  process.exit(1);
});
