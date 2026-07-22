'use strict';
// === API SINKRON INVOICE (dari OmsetAI CRM) ===
// Endpoint server-to-server dipakai backend OmsetAI (repo TERPISAH) utk mengirim
// invoice yang digenerate agent supaya muncul di akun Billing (WHMCS-style) milik
// user yang login — dicocokkan lewat EMAIL, sama persis mekanismenya dengan SSO
// login yang sudah ada (routes/client.js `GET /sso`, purpose="billing-sso"): token
// JWT umur pendek ditandatangani OmsetAI backend pakai JWT_SECRET yang SAMA, di sini
// cuma DIVERIFIKASI (app ini tak pernah menandatangani token). Kill-switch di sisi
// OmsetAI (BILLING_SYNC_ENABLED) — kalau OFF, endpoint ini sekadar tak pernah dipanggil.
//
// purpose="invoice-sync" SENGAJA beda dari "billing-sso" (dan dari token login biasa)
// supaya token tak bisa dipakai silang antar keperluan (pola sama seperti komentar di
// sahabatai-backend/src/routes/auth.js utk /auth/sso-billing-token).
const { get, run } = require('../src/db');
const { nowISO, todayISO } = require('../src/lib/format');
const { hashPassword, randomId } = require('../src/lib/crypto');
const { verifyJwtHs256 } = require('../src/lib/jwtVerify');

function sendJson(ctx, code, obj) {
  ctx.status(code);
  ctx.send(JSON.stringify(obj), 'application/json; charset=utf-8');
}

// Cari client by email; belum ada → buat otomatis (password acak, sama pola dgn /sso).
async function findOrCreateClientByEmail(email, { name, company } = {}) {
  let client = await get('SELECT * FROM clients WHERE email = ?', email);
  if (client) return client;
  const fullName = String(name || '').trim();
  const firstName = fullName.split(' ')[0] || email.split('@')[0];
  const lastName = fullName.split(' ').slice(1).join(' ') || null;
  const res = await run(
    `INSERT INTO clients (first_name, last_name, email, password, company, sahabatai_account, status, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    firstName, lastName, email, hashPassword(randomId(24)), company || null, email, 'Active', nowISO()
  );
  return await get('SELECT * FROM clients WHERE id = ?', Number(res.insertId));
}

async function nextInvoiceNum() {
  const row = await get('SELECT COUNT(*) AS c FROM invoices');
  return `INV-${(row ? row.c : 0) + 1001}`;
}

// Skema invoices di sini cuma kenal Unpaid/Paid/Cancelled (lihat schema.js) — status
// "dp" (DP terbayar sebagian) dari CRM dipetakan ke Unpaid (sisa tagihan belum lunas).
function mapStatus(crmStatus) {
  return crmStatus === 'paid' ? 'Paid' : 'Unpaid';
}

module.exports = function registerApiRoutes(router) {
  // POST /api/crm-invoices — upsert invoice dari CRM OmsetAI (idempotent: 1 nomor
  // invoice CRM = 1 baris di sini, dicocokkan lewat kolom `notes` = "CRM:<nomor>").
  // Dipanggil ulang tiap kali status invoice CRM berubah (unpaid/dp/paid) supaya
  // status di Billing ikut ter-update, bukan cuma sekali saat dibuat.
  router.post('/api/crm-invoices', async (ctx) => {
    try {
      const authHeader = ctx.req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const secret = process.env.JWT_SECRET;
      if (!secret) { sendJson(ctx, 503, { status: 'error', message: 'Sinkron belum dikonfigurasi (JWT_SECRET kosong).' }); return 'STOP'; }

      const payload = token ? verifyJwtHs256(token, secret) : null;
      if (!payload || payload.purpose !== 'invoice-sync' || !payload.email) {
        sendJson(ctx, 401, { status: 'error', message: 'Token sinkron tidak valid atau kadaluarsa.' });
        return 'STOP';
      }

      const b = ctx.body || {};
      const email = String(payload.email).trim().toLowerCase();
      const crmNumber = typeof b.invoiceNumber === 'string' ? b.invoiceNumber.trim() : '';
      const items = Array.isArray(b.items) ? b.items : [];
      if (!crmNumber || !items.length) {
        sendJson(ctx, 400, { status: 'error', message: 'invoiceNumber dan items wajib diisi.' });
        return 'STOP';
      }

      const subtotal = Number(b.subtotal) || 0;
      const total = Number(b.total) || 0;
      const status = mapStatus(b.status);
      const marker = `CRM:${crmNumber}`;
      const today = todayISO();

      const client = await findOrCreateClientByEmail(email, { name: payload.name, company: payload.company });

      let invoice = await get('SELECT * FROM invoices WHERE client_id = ? AND notes = ?', client.id, marker);
      if (invoice) {
        await run(
          'UPDATE invoices SET subtotal = ?, total = ?, status = ?, date_paid = ? WHERE id = ?',
          subtotal, total, status, status === 'Paid' ? today : null, invoice.id
        );
        await run('DELETE FROM invoice_items WHERE invoice_id = ?', invoice.id);
        invoice = await get('SELECT * FROM invoices WHERE id = ?', invoice.id);
      } else {
        const invNum = await nextInvoiceNum();
        const res = await run(
          `INSERT INTO invoices (invoice_num, client_id, date_created, date_due, date_paid, status, subtotal, total, payment_method, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          invNum, client.id, today, today, status === 'Paid' ? today : null, status, subtotal, total, 'Bank Transfer', marker
        );
        invoice = await get('SELECT * FROM invoices WHERE id = ?', Number(res.insertId));
      }

      for (const it of items) {
        const desc = String(it.description || it.name || '').slice(0, 500);
        if (!desc) continue;
        await run('INSERT INTO invoice_items (invoice_id, type, description, amount) VALUES (?,?,?,?)',
          invoice.id, 'line', desc, Number(it.amount) || 0);
      }

      sendJson(ctx, 200, { status: 'ok', invoiceId: invoice.id, invoiceNum: invoice.invoice_num, clientId: client.id });
      return 'STOP';
    } catch (err) {
      console.error('POST /api/crm-invoices gagal:', err);
      sendJson(ctx, 500, { status: 'error', message: err.message });
      return 'STOP';
    }
  });
};
