'use strict';
// Standalone admin login page (split-screen, no sidebar).
const { esc, LOGO_SVG } = require('./ui');

// Demo credential hints only render when explicitly enabled — keep them off by
// default so a production/public deployment never displays login credentials.
const SHOW_DEMO_HINTS = process.env.SHOW_DEMO_HINTS === 'true';

function LOGIN_PAGE({ error, username }) {
  return `<!doctype html><html lang="id"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Login Admin · SahabatAI Billing</title>
    <link rel="stylesheet" href="/css/style.css">
  </head><body>
  <div class="login-split">
    <div class="left">
      <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:1.5rem">
        <span style="width:44px;height:44px;border-radius:12px;background:var(--green);display:grid;place-items:center;color:#fff">${LOGO_SVG}</span>
        <b style="font-size:1.4rem">SahabatAI Billing</b>
      </div>
      <h2>Panel Administrasi</h2>
      <p>Kelola klien, order, invoice, produk, dan tim admin SahabatAI dalam satu tempat — mirip WHMCS.</p>
      <ul style="list-style:none;padding:0;margin-top:1.5rem;color:#bfe0d1;line-height:2">
        <li>✓ Kelola klien &amp; layanan</li>
        <li>✓ Order, invoice &amp; pembayaran</li>
        <li>✓ Produk, harga &amp; setup fee</li>
        <li>✓ Role &amp; hak akses administrator</li>
      </ul>
    </div>
    <div class="right">
      <div class="auth-card" style="width:100%;max-width:380px">
        <div class="logo-lg">${LOGO_SVG}</div>
        <h2 style="text-align:center;margin-bottom:.25rem">Masuk Admin</h2>
        <p class="muted" style="text-align:center;margin-top:0">Gunakan akun administrator Anda</p>
        ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
        <form method="post" action="/admin/login">
          <div class="form-row"><label class="lbl">Username / Email</label><input type="text" name="username" value="${esc(username)}" required autofocus></div>
          <div class="form-row"><label class="lbl">Password</label><input type="password" name="password" required></div>
          <button class="btn btn-block" type="submit">Masuk</button>
        </form>
        ${SHOW_DEMO_HINTS ? '<p class="muted" style="text-align:center;font-size:.78rem;margin-top:1rem">Demo: <b>musa</b> / <b>Tobethebest123#</b></p>' : ''}
        <p style="text-align:center;font-size:.8rem;margin-top:.5rem"><a href="/">← Ke Storefront</a></p>
      </div>
    </div>
  </div>
  </body></html>`;
}

module.exports = { LOGIN_PAGE };
