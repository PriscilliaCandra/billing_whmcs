'use strict';
// === SSO BILLING === Verifikasi JWT (HS256) yang diterbitkan OmsetAI backend
// (jsonwebtoken npm, algoritma default HS256) — TANPA nambah dependency npm baru
// di sini, konsisten dengan filosofi app ini ("zero external dependencies", lihat
// README/HANDOFF). HS256 cukup sederhana diverifikasi pakai node:crypto bawaan.
//
// Verifikasi, BUKAN penandatanganan — app ini tak pernah bikin token OmsetAI,
// cuma memvalidasi yang sudah ditandatangani backend OmsetAI (secret sama, di-set
// manual di .env, lihat SSO_HANDOFF.md).
const crypto = require('node:crypto');

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

/**
 * Verifikasi token JWT HS256. Return payload (object) bila valid & belum kadaluarsa,
 * atau null bila tanda tangan salah/format salah/kadaluarsa. TIDAK PERNAH melempar —
 * pemanggil cukup cek null (fail-closed).
 */
function verifyJwtHs256(token, secret) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
    if (header.alg !== 'HS256') return null; // fail-closed: cuma HS256 yg didukung di sini

    const expectedSig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
    const gotSig = b64urlDecode(sigB64);
    if (expectedSig.length !== gotSig.length || !crypto.timingSafeEqual(expectedSig, gotSig)) return null;

    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
    if (payload.exp != null && Date.now() >= payload.exp * 1000) return null; // kadaluarsa
    return payload;
  } catch {
    return null; // format apa pun yang tak terduga → tolak, jangan lempar ke pemanggil
  }
}

module.exports = { verifyJwtHs256 };
