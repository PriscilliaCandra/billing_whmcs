'use strict';
// === FIX GAP KONFIGURASI (2026-07-22) === server.js SEBELUMNYA tak pernah memuat
// .env sama sekali (nol dependency dotenv, murni process.env langsung) — nilai di
// .env cuma dokumentasi, tak pernah benar-benar masuk ke process.env. Selama ini tak
// ketahuan karena BILLING_DB_* punya default in-code yang kebetulan cocok Laragon
// lokal. Baru ketahuan saat JWT_SECRET (fitur SSO, tanpa default aman) ditambah ke
// .env tapi tetap terbaca kosong.
//
// Loader manual pakai node:fs saja (BUKAN paket dotenv) — konsisten "zero external
// dependencies" app ini. Nilai yang SUDAH ADA di process.env (mis. di-export shell/
// pm2 ecosystem) TIDAK ditimpa — .env cuma pengisi yang belum di-set, sama seperti
// perilaku dotenv asli.
const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(filename = '.env') {
  const filePath = path.join(__dirname, '..', '..', filename);
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // file tak ada → diam, byte-identik ke perilaku lama (env dari luar tetap jalan)
  }
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Buang tanda kutip pembungkus kalau ada ("val" atau 'val').
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value; // jangan timpa yang sudah di-set dari luar
  }
}

module.exports = { loadEnvFile };
