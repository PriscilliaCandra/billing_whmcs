'use strict';
// Admin area routes (WHMCS-style).
const { get, all, run } = require('../src/db');
const { adminLayout, esc, badge, rupiah, fmtDate, fmtDateTime, pager, trendChart, ICON } = require('../src/views/ui');
const { getAdminById, authenticateAdmin, can } = require('../src/services/auth');
const { activateOrder, markInvoicePaid, renewService, createOrder, isFirstPurchase, termPrice, TERM_LABELS } = require('../src/services/orders');
const { hashPassword, verifyPassword } = require('../src/lib/crypto');
const { nowISO, todayISO, addMonthsISO } = require('../src/lib/format');
const { ALL_PERMISSIONS } = require('../src/schema');
const { LOGIN_PAGE } = require('../src/views/adminAuth');

const PERM_LABELS = {
  manage_clients: 'Kelola Klien',
  manage_orders: 'Kelola Order & Layanan',
  manage_invoices: 'Kelola Invoice',
  manage_products: 'Kelola Produk & Harga',
  manage_admins: 'Kelola Akun Admin',
  manage_roles: 'Kelola Role & Hak Akses',
  view_reports: 'Lihat Laporan',
};

// ---------- middleware ----------
async function requireAdmin(ctx) {
  if (!ctx.session.adminId) { ctx.redirect('/admin/login'); return 'STOP'; }
  const admin = await getAdminById(ctx.session.adminId);
  if (!admin || admin.status !== 'Active') { ctx.session.adminId = null; ctx.redirect('/admin/login'); return 'STOP'; }
  ctx.admin = admin;
}
function requirePerm(perm) {
  return async (ctx) => {
    if (!can(ctx.admin, perm)) {
      ctx.status(403);
      await page(ctx, {
        title: 'Akses Ditolak', active: '', crumb: 'Akses Ditolak',
        body: `<div class="card"><div class="card-body"><h2>403 — Akses Ditolak</h2>
          <p class="muted">Role <b>${esc(ctx.admin.roleName)}</b> tidak punya izin <b>${esc(PERM_LABELS[perm] || perm)}</b>.</p>
          <a href="/admin" class="btn">Kembali ke Dashboard</a></div></div>`,
      });
      return 'STOP';
    }
  };
}

// ---------- render helpers ----------
async function page(ctx, { title, active, crumb, body }) {
  ctx.html(await adminLayout({ title, active: active || '', admin: ctx.admin, crumb: crumb || title, body, session: ctx.session }));
}
function field(label, name, value = '', opts = {}) {
  const help = opts.help ? `<div class="help">${esc(opts.help)}</div>` : '';
  if (opts.textarea) return `<div class="form-row"><label class="lbl">${esc(label)}</label><textarea name="${name}">${esc(value)}</textarea>${help}</div>`;
  if (opts.select) return `<div class="form-row"><label class="lbl">${esc(label)}</label><select name="${name}">${opts.select.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${help}</div>`;
  return `<div class="form-row"><label class="lbl">${esc(label)}</label><input type="${opts.type || 'text'}" name="${name}" value="${esc(value)}" ${opts.required ? 'required' : ''} ${opts.attrs || ''}>${help}</div>`;
}
function tableCard(head, rowsHtml, empty = 'Belum ada data.') {
  const body = rowsHtml && rowsHtml.trim()
    ? `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
    : `<div class="card-body"><p class="muted" style="text-align:center;padding:1.5rem 0;">${esc(empty)}</p></div>`;
  return `<div class="card">${body}</div>`;
}
function paginate(query, total, perPage = 15) {
  const page = Math.max(1, parseInt(query.page) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  return { page, totalPages, perPage, offset: (page - 1) * perPage };
}

module.exports = function registerAdmin(router) {
  // ===================== AUTH =====================
  router.get('/admin/login', async (ctx) => {
    if (ctx.session.adminId) return ctx.redirect('/admin');
    ctx.html(LOGIN_PAGE({ error: null, username: '' }));
  });
  router.post('/admin/login', async (ctx) => {
    const { username = '', password = '' } = ctx.body;
    const admin = await authenticateAdmin(username.trim(), password);
    if (!admin) return ctx.html(LOGIN_PAGE({ error: 'Username atau password salah.', username }));
    ctx.session.adminId = admin.id;
    await run('UPDATE admins SET last_login = ? WHERE id = ?', nowISO(), admin.id);
    ctx.redirect('/admin');
  });
  router.get('/admin/logout', async (ctx) => { ctx.session.adminId = null; ctx.redirect('/admin/login'); });

  // ===================== DASHBOARD =====================
  router.get('/admin', requireAdmin, async (ctx) => {
    const today = todayISO();
    const monthStart = today.slice(0, 7) + '-01';

    const pendingOrders = (await get("SELECT COUNT(*) c FROM orders WHERE status='Pending'")).c;
    const unpaid = await get("SELECT COUNT(*) c, COALESCE(SUM(total),0) s FROM invoices WHERE status='Unpaid'");
    const expiringSoon = (await get(`SELECT COUNT(*) c FROM services WHERE status='Active' AND type='package'
        AND next_due_date IS NOT NULL AND next_due_date <= CURDATE() + INTERVAL 7 DAY`)).c;
    const newClients = (await get('SELECT COUNT(*) c FROM clients WHERE created_at >= ?', monthStart)).c;

    const revenue = (await get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE status='Paid'")).s;
    const monthRevenue = (await get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE status='Paid' AND date_paid >= ?", monthStart)).s;
    const todayRevenue = (await get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE status='Paid' AND date_paid = ?", today)).s;

    const invoicesThisMonth = (await get('SELECT COUNT(*) c FROM invoices WHERE date_created >= ?', monthStart)).c;
    const ordersActiveThisMonth = (await get("SELECT COUNT(*) c FROM orders WHERE status='Active' AND created_at >= ?", monthStart)).c;
    const renewalsThisMonth = (await get("SELECT COUNT(*) c FROM invoices WHERE notes='Renewal' AND date_created >= ?", monthStart)).c;

    // 14-day revenue trend for the chart (real data — zero-filled for days without paid invoices).
    const trendRows = await all(`SELECT date_paid d, SUM(total) s FROM invoices WHERE status='Paid' AND date_paid >= CURDATE() - INTERVAL 13 DAY GROUP BY date_paid`);
    const trendMap = Object.fromEntries(trendRows.map((r) => [r.d, r.s]));
    const trendData = [];
    for (let i = 13; i >= 0; i--) {
      const d = addMonthsISO(today, 0);
      const dt = new Date(today); dt.setDate(dt.getDate() - i);
      const iso = dt.toISOString().slice(0, 10);
      trendData.push({ label: fmtDate(iso), shortLabel: iso.slice(8, 10) + '/' + iso.slice(5, 7), value: trendMap[iso] || 0 });
    }

    const upcomingRenewals = await all(`SELECT s.*, c.first_name, c.last_name FROM services s JOIN clients c ON c.id = s.client_id
        WHERE s.status='Active' AND s.type='package' AND s.next_due_date IS NOT NULL
        AND s.next_due_date <= CURDATE() + INTERVAL 7 DAY ORDER BY s.next_due_date LIMIT 8`);

    const recentOrders = await all(`SELECT o.*, c.first_name, c.last_name, c.company FROM orders o JOIN clients c ON c.id=o.client_id ORDER BY o.id DESC LIMIT 8`);
    const recentInvoices = await all(`SELECT i.*, c.first_name, c.last_name FROM invoices i JOIN clients c ON c.id=i.client_id ORDER BY i.id DESC LIMIT 8`);

    const orderRows = recentOrders.map((o) => `<tr>
      <td><a href="/admin/orders/${o.id}">${esc(o.order_num)}</a></td>
      <td><a href="/admin/clients/${o.client_id}">${esc((o.first_name || '') + ' ' + (o.last_name || ''))}</a><div class="muted" style="font-size:.75rem">${esc(o.company || '')}</div></td>
      <td class="num">${rupiah(o.amount)}</td>
      <td>${badge(o.status)}</td>
      <td class="muted nowrap">${fmtDate(o.created_at)}</td></tr>`).join('');

    const invRows = recentInvoices.map((i) => `<tr>
      <td><a href="/admin/invoices/${i.id}">${esc(i.invoice_num)}</a></td>
      <td>${esc((i.first_name || '') + ' ' + (i.last_name || ''))}</td>
      <td class="num">${rupiah(i.total)}</td>
      <td>${badge(i.status)}</td></tr>`).join('');

    const renewalRows = upcomingRenewals.map((s) => `<tr>
      <td><a href="/admin/clients/${s.client_id}">${esc(s.first_name + ' ' + (s.last_name || ''))}</a></td>
      <td>${esc(s.name)}</td>
      <td class="num">${rupiah(s.recurring_amount)}</td>
      <td class="nowrap">${fmtDate(s.next_due_date)}</td></tr>`).join('');

    const body = `
      <div class="page-head"><div><h1>Dashboard</h1><div class="sub">Ringkasan billing OmsetAI</div></div></div>

      <div class="stats">
        <div class="stat-wh c-green"><div class="stat-ic">${ICON.cart(20)}</div><div><div class="stat-num">${pendingOrders}</div><div class="stat-lbl">Pending Orders</div></div></div>
        <div class="stat-wh c-pink"><div class="stat-ic">${ICON.receipt(20)}</div><div><div class="stat-num">${unpaid.c}</div><div class="stat-lbl">Invoice Belum Dibayar</div></div></div>
        <div class="stat-wh c-orange"><div class="stat-ic">${ICON.clock(20)}</div><div><div class="stat-num">${expiringSoon}</div><div class="stat-lbl">Layanan Jatuh Tempo 7 Hari</div></div></div>
        <div class="stat-wh c-teal"><div class="stat-ic">${ICON.user(20)}</div><div><div class="stat-num">${newClients}</div><div class="stat-lbl">Klien Baru Bulan Ini</div></div></div>
      </div>

      <div class="grid-2">
        <div class="card chart-card"><div class="card-head"><h3>Pendapatan 14 Hari Terakhir</h3></div>
          <div class="card-body">${trendChart(trendData)}</div>
        </div>
        <div class="card"><div class="card-head"><h3>Aktivitas Bulan Ini</h3></div>
          <div class="icon-grid">
            <div class="ig-item"><div class="ig-ic">${ICON.receipt(18)}</div><div class="ig-num">${invoicesThisMonth}</div><div class="ig-lbl">Invoice Dibuat</div></div>
            <div class="ig-item"><div class="ig-ic">${ICON.check(18)}</div><div class="ig-num">${ordersActiveThisMonth}</div><div class="ig-lbl">Order Aktif</div></div>
            <div class="ig-item"><div class="ig-ic">${ICON.refresh(18)}</div><div class="ig-num">${renewalsThisMonth}</div><div class="ig-lbl">Perpanjangan</div></div>
            <div class="ig-item"><div class="ig-ic">${ICON.user(18)}</div><div class="ig-num">${newClients}</div><div class="ig-lbl">Klien Baru</div></div>
          </div>
        </div>
      </div>

      <div class="grid-2 mt">
        <div class="card"><div class="card-head"><h3>Billing</h3></div><div class="card-body" style="display:flex;gap:2rem">
          <div><div class="muted" style="font-size:.78rem">Hari Ini</div><div style="font-size:1.4rem;font-weight:800;color:var(--green-700)">${rupiah(todayRevenue)}</div></div>
          <div><div class="muted" style="font-size:.78rem">Bulan Ini</div><div style="font-size:1.4rem;font-weight:800;color:var(--green-700)">${rupiah(monthRevenue)}</div></div>
          <div><div class="muted" style="font-size:.78rem">Total Lunas</div><div style="font-size:1.4rem;font-weight:800;color:var(--green-dark)">${rupiah(revenue)}</div></div>
        </div></div>
        <div class="card"><div class="card-head"><h3>Layanan Segera Jatuh Tempo</h3><a href="/admin/services" class="muted" style="font-size:.8rem">Lihat semua →</a></div>
          ${tableCard('<th>Klien</th><th>Produk</th><th class="num">Harga</th><th>Jatuh Tempo</th>', renewalRows, 'Tidak ada layanan jatuh tempo dalam 7 hari.')}
        </div>
      </div>

      <div class="grid-2 mt">
        <div>
          <div class="card-head" style="background:#fff;border:1px solid var(--line);border-bottom:none;border-radius:12px 12px 0 0;"><h3>Order Terbaru</h3><a href="/admin/orders" class="muted" style="font-size:.8rem">Lihat semua →</a></div>
          ${tableCard('<th>Order</th><th>Klien</th><th class="num">Nilai</th><th>Status</th><th>Tanggal</th>', orderRows).replace('<div class="card">', '<div class="card" style="border-radius:0 0 12px 12px">')}
        </div>
        <div>
          <div class="card-head" style="background:#fff;border:1px solid var(--line);border-bottom:none;border-radius:12px 12px 0 0;"><h3>Invoice Terbaru</h3></div>
          <div class="card" style="border-radius:0 0 12px 12px"><div class="card-body" style="padding:0"><div style="padding:.75rem 1rem;border-bottom:1px solid var(--line);display:flex;justify-content:space-between"><span class="muted">Belum dibayar</span><b>${unpaid.c} · ${rupiah(unpaid.s)}</b></div>
          <div class="table-wrap"><table class="data"><tbody>${invRows || '<tr><td class="muted" style="padding:1rem">Belum ada invoice.</td></tr>'}</tbody></table></div></div></div>
        </div>
      </div>`;
    await page(ctx, { title: 'Dashboard', active: '/admin', crumb: '<b>Dashboard</b>', body });
  });

  // ===================== MY ACCOUNT (self-service, any logged-in admin) =====================
  router.get('/admin/myaccount', requireAdmin, async (ctx) => {
    const a = ctx.admin;
    const body = `
      <div class="page-head"><div><h1>My Account</h1><div class="sub">Kelola profil login Anda sendiri</div></div></div>
      <form method="post" action="/admin/myaccount"><div class="card" style="max-width:520px"><div class="card-body">
        ${field('Nama Lengkap', 'name', a.name, { required: true })}
        <div class="form-row"><label class="lbl">Username</label><input type="text" value="${esc(a.username)}" disabled></div>
        ${field('Email', 'email', a.email, { type: 'email' })}
        <div class="form-row"><label class="lbl">Role</label><input type="text" value="${esc(a.roleName)}" disabled></div>
        <hr style="border:none;border-top:1px solid var(--line);margin:1rem 0">
        ${field('Password Baru (opsional)', 'password', '', { type: 'password', help: 'Kosongkan jika tidak diubah.' })}
        <button class="btn" type="submit">Simpan</button>
      </div></div></form>`;
    await page(ctx, { title: 'My Account', active: '', crumb: '<b>My Account</b>', body });
  });
  router.post('/admin/myaccount', requireAdmin, async (ctx) => {
    const b = ctx.body; const a = ctx.admin;
    await run('UPDATE admins SET name=?, email=? WHERE id=?', b.name || a.name, b.email || '', a.id);
    if (b.password) await run('UPDATE admins SET password=? WHERE id=?', hashPassword(b.password), a.id);
    ctx.flash('success', 'Profil Anda diperbarui.');
    ctx.redirect('/admin/myaccount');
  });

  // ===================== CLIENTS =====================
  router.get('/admin/clients', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    const q = (ctx.query.q || '').trim();
    const like = `%${q}%`;
    const where = q ? 'WHERE first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company LIKE ?' : '';
    const args = q ? [like, like, like, like] : [];
    const total = (await get(`SELECT COUNT(*) c FROM clients ${where}`, ...args)).c;
    const { page: pg, totalPages, perPage, offset } = paginate(ctx.query, total);
    const rows = await all(`SELECT c.*, (SELECT COUNT(*) FROM services s WHERE s.client_id=c.id AND s.status='Active') AS svc,
        (SELECT COALESCE(SUM(total),0) FROM invoices i WHERE i.client_id=c.id AND i.status='Unpaid') AS due
        FROM clients c ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...args, perPage, offset);
    const rowsHtml = rows.map((c) => `<tr>
      <td>#${c.id}</td>
      <td><a href="/admin/clients/${c.id}">${esc(c.first_name + ' ' + (c.last_name || ''))}</a><div class="muted" style="font-size:.75rem">${esc(c.email)}</div></td>
      <td>${esc(c.company || '-')}</td>
      <td class="num">${c.svc}</td>
      <td class="num">${c.due > 0 ? '<span class="badge badge-amber">' + rupiah(c.due) + '</span>' : '-'}</td>
      <td>${badge(c.status)}</td>
      <td class="nowrap"><a class="btn btn-ghost btn-sm" href="/admin/clients/${c.id}">Detail</a></td></tr>`).join('');
    const body = `
      <div class="page-head"><div><h1>Klien</h1><div class="sub">${total} akun klien</div></div>
        <a class="btn" href="/admin/clients/new">+ Tambah Klien</a></div>
      <form class="toolbar" method="get">
        <input class="search" type="text" name="q" placeholder="Cari nama, email, atau perusahaan…" value="${esc(q)}">
        <button class="btn btn-outline" type="submit">Cari</button>
        ${q ? '<a class="btn btn-ghost" href="/admin/clients">Reset</a>' : ''}
      </form>
      ${tableCard('<th>ID</th><th>Nama</th><th>Perusahaan</th><th class="num">Layanan</th><th class="num">Tagihan</th><th>Status</th><th></th>', rowsHtml, 'Tidak ada klien.')}
      ${pager('/admin/clients', pg, totalPages, q ? '&q=' + encodeURIComponent(q) : '')}`;
    await page(ctx, { title: 'Klien', active: '/admin/clients', crumb: '<b>Klien</b>', body });
  });

  router.get('/admin/clients/new', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    await page(ctx, { title: 'Tambah Klien', active: '/admin/clients', crumb: '<a href="/admin/clients">Klien</a> / <b>Tambah</b>', body: clientForm({}, '/admin/clients/new', 'Tambah Klien') });
  });
  router.post('/admin/clients/new', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    const b = ctx.body;
    if (!b.email || !b.first_name || !b.password) { ctx.flash('error', 'Nama depan, email, dan password wajib diisi.'); return ctx.redirect('/admin/clients/new'); }
    if (await get('SELECT id FROM clients WHERE email = ?', b.email.trim())) { ctx.flash('error', 'Email sudah terdaftar.'); return ctx.redirect('/admin/clients/new'); }
    const res = await run(`INSERT INTO clients (first_name,last_name,email,password,company,phone,address,city,country,sahabatai_account,status,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      b.first_name.trim(), (b.last_name || '').trim(), b.email.trim(), hashPassword(b.password),
      b.company || '', b.phone || '', b.address || '', b.city || '', b.country || 'Indonesia',
      b.sahabatai_account || b.email.trim(), b.status || 'Active', b.notes || '', nowISO());
    ctx.flash('success', 'Klien berhasil ditambahkan.');
    ctx.redirect('/admin/clients/' + Number(res.insertId));
  });

  router.get('/admin/clients/:id', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    const c = await get('SELECT * FROM clients WHERE id = ?', ctx.params.id);
    if (!c) return ctx.notFound('Klien tidak ditemukan');
    const services = await all('SELECT * FROM services WHERE client_id = ? ORDER BY id DESC', c.id);
    const invoices = await all('SELECT * FROM invoices WHERE client_id = ? ORDER BY id DESC', c.id);
    const orders = await all('SELECT * FROM orders WHERE client_id = ? ORDER BY id DESC', c.id);

    const svcRows = services.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.billing_cycle)}</td>
      <td class="num">${rupiah(s.recurring_amount)}</td><td class="nowrap">${s.next_due_date ? fmtDate(s.next_due_date) : '-'}</td><td>${badge(s.status)}</td></tr>`).join('');
    const invRows = invoices.map((i) => `<tr><td><a href="/admin/invoices/${i.id}">${esc(i.invoice_num)}</a></td>
      <td class="nowrap">${fmtDate(i.date_created)}</td><td class="num">${rupiah(i.total)}</td><td>${badge(i.status)}</td></tr>`).join('');
    const ordRows = orders.map((o) => `<tr><td><a href="/admin/orders/${o.id}">${esc(o.order_num)}</a></td>
      <td class="nowrap">${fmtDate(o.created_at)}</td><td class="num">${rupiah(o.amount)}</td><td>${badge(o.status)}</td></tr>`).join('');

    const body = `
      <div class="page-head"><div><h1>${esc(c.first_name + ' ' + (c.last_name || ''))}</h1>
        <div class="sub">${esc(c.company || 'Perorangan')} · Klien #${c.id} · ${badge(c.status)}</div></div>
        <div style="display:flex;gap:.5rem">
          <a class="btn btn-outline" href="/">Buat order (storefront) ↗</a>
        </div></div>
      <div class="grid-2">
        <div>
          <form method="post" action="/admin/clients/${c.id}">
            <div class="card"><div class="card-head"><h3>Profil Klien</h3><button class="btn btn-sm" type="submit">Simpan Perubahan</button></div>
              <div class="card-body">
                <div class="form-grid">
                  ${field('Nama Depan', 'first_name', c.first_name, { required: true })}
                  ${field('Nama Belakang', 'last_name', c.last_name)}
                  ${field('Email', 'email', c.email, { type: 'email', required: true })}
                  ${field('No. HP', 'phone', c.phone)}
                  ${field('Perusahaan', 'company', c.company)}
                  ${field('Akun OmsetAI', 'sahabatai_account', c.sahabatai_account, { help: 'Email login di ai.indotrading.com' })}
                  ${field('Kota', 'city', c.city)}
                  ${field('Negara', 'country', c.country)}
                </div>
                ${field('Alamat', 'address', c.address, { textarea: true })}
                ${field('Status', 'status', c.status, { select: ['Active', 'Inactive', 'Closed'].map((s) => ({ value: s, label: s })) })}
                ${field('Catatan Admin', 'notes', c.notes, { textarea: true })}
              </div>
            </div>
          </form>
          <div class="card mt"><div class="card-head"><h3>Layanan</h3></div>
            ${services.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Produk</th><th>Siklus</th><th class="num">Harga</th><th>Jatuh Tempo</th><th>Status</th></tr></thead><tbody>${svcRows}</tbody></table></div>` : '<div class="card-body muted">Belum ada layanan.</div>'}
          </div>
          <div class="card mt"><div class="card-head"><h3>Order</h3></div>
            ${orders.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Order</th><th>Tanggal</th><th class="num">Nilai</th><th>Status</th></tr></thead><tbody>${ordRows}</tbody></table></div>` : '<div class="card-body muted">Belum ada order.</div>'}
          </div>
        </div>
        <div>
          <div class="card"><div class="card-head"><h3>Invoice</h3></div>
            ${invoices.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>No.</th><th>Tgl</th><th class="num">Total</th><th>Status</th></tr></thead><tbody>${invRows}</tbody></table></div>` : '<div class="card-body muted">Belum ada invoice.</div>'}
          </div>
          <div class="card mt"><div class="card-head"><h3>Keamanan</h3></div><div class="card-body">
            <form method="post" action="/admin/clients/${c.id}/password">
              ${field('Reset Password Klien', 'password', '', { type: 'password', help: 'Kosongkan jika tidak diubah.' })}
              <button class="btn btn-outline btn-sm" type="submit">Reset Password</button>
            </form>
            <hr style="border:none;border-top:1px solid var(--line);margin:1rem 0">
            <form method="post" action="/admin/clients/${c.id}/delete" onsubmit="return confirm('Hapus klien ini beserta seluruh data terkait?')">
              <button class="btn btn-danger btn-sm" type="submit">Hapus Klien</button>
            </form>
          </div></div>
        </div>
      </div>`;
    await page(ctx, { title: c.first_name, active: '/admin/clients', crumb: `<a href="/admin/clients">Klien</a> / <b>${esc(c.first_name)}</b>`, body });
  });

  router.post('/admin/clients/:id', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    const c = await get('SELECT * FROM clients WHERE id = ?', ctx.params.id);
    if (!c) return ctx.notFound();
    const b = ctx.body;
    await run(`UPDATE clients SET first_name=?,last_name=?,email=?,company=?,phone=?,address=?,city=?,country=?,sahabatai_account=?,status=?,notes=? WHERE id=?`,
      b.first_name || c.first_name, b.last_name || '', b.email || c.email, b.company || '', b.phone || '',
      b.address || '', b.city || '', b.country || 'Indonesia', b.sahabatai_account || '', b.status || 'Active', b.notes || '', c.id);
    ctx.flash('success', 'Profil klien diperbarui.');
    ctx.redirect('/admin/clients/' + c.id);
  });
  router.post('/admin/clients/:id/password', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    if (ctx.body.password) { await run('UPDATE clients SET password=? WHERE id=?', hashPassword(ctx.body.password), ctx.params.id); ctx.flash('success', 'Password klien direset.'); }
    ctx.redirect('/admin/clients/' + ctx.params.id);
  });
  router.post('/admin/clients/:id/delete', requireAdmin, requirePerm('manage_clients'), async (ctx) => {
    const id = ctx.params.id;
    await run('DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE client_id=?)', id);
    await run('DELETE FROM invoices WHERE client_id=?', id);
    await run('DELETE FROM services WHERE client_id=?', id);
    await run('DELETE FROM orders WHERE client_id=?', id);
    await run('DELETE FROM clients WHERE id=?', id);
    ctx.flash('success', 'Klien dihapus.');
    ctx.redirect('/admin/clients');
  });

  // ===================== ORDERS =====================
  router.get('/admin/orders', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const status = ctx.query.status || '';
    const where = status ? 'WHERE o.status = ?' : '';
    const args = status ? [status] : [];
    const total = (await get(`SELECT COUNT(*) c FROM orders o ${where}`, ...args)).c;
    const { page: pg, totalPages, perPage, offset } = paginate(ctx.query, total);
    const rows = await all(`SELECT o.*, c.first_name, c.last_name, c.company FROM orders o JOIN clients c ON c.id=o.client_id ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`, ...args, perPage, offset);
    const rowsHtml = rows.map((o) => `<tr>
      <td><a href="/admin/orders/${o.id}">${esc(o.order_num)}</a></td>
      <td><a href="/admin/clients/${o.client_id}">${esc(o.first_name + ' ' + (o.last_name || ''))}</a></td>
      <td class="num">${rupiah(o.amount)}</td><td>${badge(o.status)}</td>
      <td class="nowrap muted">${fmtDate(o.created_at)}</td>
      <td class="nowrap">${o.status === 'Pending' ? `<form method="post" action="/admin/orders/${o.id}/accept" style="display:inline"><button class="btn btn-sm">Terima</button></form>` : `<a class="btn btn-ghost btn-sm" href="/admin/orders/${o.id}">Detail</a>`}</td></tr>`).join('');
    const filter = (s, l) => `<a class="btn btn-sm ${status === s ? '' : 'btn-ghost'}" href="/admin/orders${s ? '?status=' + s : ''}">${l}</a>`;
    const body = `
      <div class="page-head"><div><h1>Order</h1><div class="sub">${total} order</div></div></div>
      <div class="toolbar">${filter('', 'Semua')}${filter('Pending', 'Pending')}${filter('Active', 'Aktif')}${filter('Cancelled', 'Batal')}</div>
      ${tableCard('<th>Order</th><th>Klien</th><th class="num">Nilai</th><th>Status</th><th>Tanggal</th><th></th>', rowsHtml, 'Tidak ada order.')}
      ${pager('/admin/orders', pg, totalPages, status ? '&status=' + status : '')}`;
    await page(ctx, { title: 'Order', active: '/admin/orders', crumb: '<b>Order</b>', body });
  });

  router.get('/admin/orders/new', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const clients = await all('SELECT id, first_name, last_name, company, email FROM clients ORDER BY first_name');
    const packages = await all("SELECT * FROM products WHERE type='package' AND status='Active' ORDER BY sort_order");
    const addon = await get("SELECT * FROM products WHERE slug='training-user'");
    const clientOpts = clients.map((c) => `<option value="${c.id}">${esc(c.first_name + ' ' + (c.last_name || ''))} — ${esc(c.company || c.email)}</option>`).join('');
    const pkgOpts = packages.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const body = `
      <div class="page-head"><div><h1>Add New Order</h1><div class="sub">Buat order manual untuk klien (mis. order via telepon/WA)</div></div></div>
      <form method="post" action="/admin/orders/new"><div class="card" style="max-width:620px"><div class="card-body">
        ${field('Klien', 'client_id', '', { select: [{ value: '', label: '— Pilih klien —' }, ...clients.map((c) => ({ value: c.id, label: c.first_name + ' ' + (c.last_name || '') + ' — ' + (c.company || c.email) }))], required: true })}
        ${field('Paket', 'package_id', '', { select: [{ value: '', label: '— Pilih paket —' }, ...packages.map((p) => ({ value: p.id, label: p.name }))], required: true })}
        ${field('Periode', 'term', '12', { select: [{ value: 3, label: '3 Bulan' }, { value: 6, label: '6 Bulan' }, { value: 12, label: '1 Tahun' }] })}
        <label class="opt-card" style="cursor:pointer"><input type="checkbox" name="addon_training"><div><div class="opt-title">${esc(addon.name)}</div><div class="muted" style="font-size:.78rem">${esc(addon.tagline)}</div></div></label>
        <button class="btn" type="submit" style="margin-top:1rem">Buat Order</button>
        <a class="btn btn-ghost" href="/admin/orders">Batal</a>
      </div></div></form>`;
    await page(ctx, { title: 'Add New Order', active: '/admin/orders', crumb: `<a href="/admin/orders">Order</a> / <b>Add New Order</b>`, body });
  });
  router.post('/admin/orders/new', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const b = ctx.body;
    const client = await get('SELECT id FROM clients WHERE id=?', b.client_id);
    const pkg = await get('SELECT id FROM products WHERE id=?', b.package_id);
    if (!client || !pkg) { ctx.flash('error', 'Klien dan paket wajib dipilih.'); return ctx.redirect('/admin/orders/new'); }
    const term = [3, 6, 12].includes(Number(b.term)) ? Number(b.term) : 12;
    const addons = [];
    if (b.addon_training === 'on') {
      const addon = await get("SELECT * FROM products WHERE slug='training-user'");
      if (addon) addons.push({ id: addon.id, qty: 1 });
    }
    const { order } = await createOrder(client.id, { packageId: pkg.id, term, addons });
    ctx.flash('success', `Order ${order.order_num} dibuat untuk klien.`);
    ctx.redirect('/admin/orders/' + order.id);
  });

  router.get('/admin/orders/:id', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const o = await get('SELECT * FROM orders WHERE id = ?', ctx.params.id);
    if (!o) return ctx.notFound();
    const c = await get('SELECT * FROM clients WHERE id = ?', o.client_id);
    const services = await all('SELECT * FROM services WHERE order_id = ?', o.id);
    const inv = await get('SELECT * FROM invoices WHERE order_id = ?', o.id);
    const svcRows = services.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.billing_cycle)}</td><td class="num">${rupiah(s.recurring_amount)}</td><td class="num">${s.setup_fee ? rupiah(s.setup_fee) : '-'}</td><td>${badge(s.status)}</td></tr>`).join('');
    const body = `
      <div class="page-head"><div><h1>Order ${esc(o.order_num)}</h1><div class="sub">${fmtDateTime(o.created_at)} · ${badge(o.status)}</div></div>
      <div style="display:flex;gap:.5rem">
        ${o.status === 'Pending' ? `<form method="post" action="/admin/orders/${o.id}/accept"><button class="btn" style="display:inline-flex;align-items:center;gap:.4rem">${ICON.check(14)} Terima Order</button></form>
          <form method="post" action="/admin/orders/${o.id}/cancel" onsubmit="return confirm('Batalkan order?')"><button class="btn btn-danger">Batalkan</button></form>` : ''}
      </div></div>
      <div class="grid-2">
        <div class="card"><div class="card-head"><h3>Item Order</h3></div>
          <div class="table-wrap"><table class="data"><thead><tr><th>Produk</th><th>Siklus</th><th class="num">Harga</th><th class="num">Setup</th><th>Status</th></tr></thead><tbody>${svcRows}</tbody></table></div>
          <div class="card-body right"><b>Total: ${rupiah(o.amount)}</b></div>
        </div>
        <div class="card"><div class="card-head"><h3>Klien & Invoice</h3></div><div class="card-body">
          <dl class="dl">
            <dt>Klien</dt><dd><a href="/admin/clients/${c.id}">${esc(c.first_name + ' ' + (c.last_name || ''))}</a></dd>
            <dt>Perusahaan</dt><dd>${esc(c.company || '-')}</dd>
            <dt>Email</dt><dd>${esc(c.email)}</dd>
            <dt>Invoice</dt><dd>${inv ? `<a href="/admin/invoices/${inv.id}">${esc(inv.invoice_num)}</a> ${badge(inv.status)}` : '-'}</dd>
            <dt>Pembayaran</dt><dd>${esc(o.payment_method)}</dd>
          </dl>
        </div></div>
      </div>`;
    await page(ctx, { title: 'Order ' + o.order_num, active: '/admin/orders', crumb: `<a href="/admin/orders">Order</a> / <b>${esc(o.order_num)}</b>`, body });
  });
  router.post('/admin/orders/:id/accept', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    await activateOrder(Number(ctx.params.id));
    ctx.flash('success', 'Order diterima — layanan diaktifkan & invoice ditandai lunas.');
    ctx.redirect('/admin/orders/' + ctx.params.id);
  });
  router.post('/admin/orders/:id/cancel', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    await run("UPDATE orders SET status='Cancelled' WHERE id=?", ctx.params.id);
    await run("UPDATE services SET status='Cancelled' WHERE order_id=?", ctx.params.id);
    await run("UPDATE invoices SET status='Cancelled' WHERE order_id=? AND status='Unpaid'", ctx.params.id);
    ctx.flash('info', 'Order dibatalkan.');
    ctx.redirect('/admin/orders/' + ctx.params.id);
  });

  // ===================== INVOICES =====================
  router.get('/admin/invoices', requireAdmin, requirePerm('manage_invoices'), async (ctx) => {
    const status = ctx.query.status || '';
    const where = status ? 'WHERE i.status = ?' : '';
    const args = status ? [status] : [];
    const total = (await get(`SELECT COUNT(*) c FROM invoices i ${where}`, ...args)).c;
    const { page: pg, totalPages, perPage, offset } = paginate(ctx.query, total);
    const rows = await all(`SELECT i.*, c.first_name, c.last_name FROM invoices i JOIN clients c ON c.id=i.client_id ${where} ORDER BY i.id DESC LIMIT ? OFFSET ?`, ...args, perPage, offset);
    const rowsHtml = rows.map((i) => `<tr>
      <td><a href="/admin/invoices/${i.id}">${esc(i.invoice_num)}</a></td>
      <td><a href="/admin/clients/${i.client_id}">${esc(i.first_name + ' ' + (i.last_name || ''))}</a></td>
      <td class="nowrap muted">${fmtDate(i.date_created)}</td><td class="num">${rupiah(i.total)}</td><td>${badge(i.status)}</td>
      <td class="nowrap">${i.status === 'Unpaid' ? `<form method="post" action="/admin/invoices/${i.id}/pay" style="display:inline"><button class="btn btn-sm">Tandai Lunas</button></form>` : `<a class="btn btn-ghost btn-sm" href="/admin/invoices/${i.id}">Lihat</a>`}</td></tr>`).join('');
    const filter = (s, l) => `<a class="btn btn-sm ${status === s ? '' : 'btn-ghost'}" href="/admin/invoices${s ? '?status=' + s : ''}">${l}</a>`;
    const body = `
      <div class="page-head"><div><h1>Invoice</h1><div class="sub">${total} invoice</div></div></div>
      <div class="toolbar">${filter('', 'Semua')}${filter('Unpaid', 'Belum Bayar')}${filter('Paid', 'Lunas')}${filter('Cancelled', 'Batal')}</div>
      ${tableCard('<th>No.</th><th>Klien</th><th>Tanggal</th><th class="num">Total</th><th>Status</th><th></th>', rowsHtml, 'Tidak ada invoice.')}
      ${pager('/admin/invoices', pg, totalPages, status ? '&status=' + status : '')}`;
    await page(ctx, { title: 'Invoice', active: '/admin/invoices', crumb: '<b>Invoice</b>', body });
  });

  router.get('/admin/invoices/:id', requireAdmin, requirePerm('manage_invoices'), async (ctx) => {
    const inv = await get('SELECT * FROM invoices WHERE id = ?', ctx.params.id);
    if (!inv) return ctx.notFound();
    const c = await get('SELECT * FROM clients WHERE id = ?', inv.client_id);
    const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ?', inv.id);
    const itemRows = items.map((it) => `<tr><td>${esc(it.description)}</td><td class="num">${rupiah(it.amount)}</td></tr>`).join('');
    const body = `
      <div class="page-head"><div><h1>Invoice ${esc(inv.invoice_num)}</h1><div class="sub">${badge(inv.status)} · Dibuat ${fmtDate(inv.date_created)}</div></div>
        <div style="display:flex;gap:.5rem">
          ${inv.status === 'Unpaid' ? `<form method="post" action="/admin/invoices/${inv.id}/pay"><button class="btn">Tandai Lunas</button></form>
          <form method="post" action="/admin/invoices/${inv.id}/cancel" onsubmit="return confirm('Batalkan invoice?')"><button class="btn btn-ghost">Batalkan</button></form>` : ''}
        </div></div>
      <div class="grid-2">
        <div class="card"><div class="card-body">
          <div style="display:flex;justify-content:space-between;margin-bottom:1.5rem">
            <div><b style="font-size:1.1rem;color:var(--green-dark)">OmsetAI Billing</b><div class="muted">PT Indotrading</div></div>
            <div class="right"><div class="muted">Invoice</div><b>${esc(inv.invoice_num)}</b><div class="muted">Jatuh tempo ${fmtDate(inv.date_due)}</div></div>
          </div>
          <div style="margin-bottom:1rem"><div class="muted">Ditagihkan kepada:</div><b>${esc(c.first_name + ' ' + (c.last_name || ''))}</b><div>${esc(c.company || '')}</div><div class="muted">${esc(c.email)}</div></div>
          <table class="data" style="border:1px solid var(--line);border-radius:8px;overflow:hidden"><thead><tr><th>Deskripsi</th><th class="num">Jumlah</th></tr></thead><tbody>${itemRows}
            <tr><td class="right"><b>Subtotal</b></td><td class="num">${rupiah(inv.subtotal)}</td></tr>
            <tr><td class="right"><b>Total</b></td><td class="num"><b>${rupiah(inv.total)}</b></td></tr></tbody></table>
        </div></div>
        <div class="card"><div class="card-head"><h3>Detail</h3></div><div class="card-body">
          <dl class="dl">
            <dt>Klien</dt><dd><a href="/admin/clients/${c.id}">${esc(c.first_name)}</a></dd>
            <dt>Status</dt><dd>${badge(inv.status)}</dd>
            <dt>Dibayar</dt><dd>${inv.date_paid ? fmtDate(inv.date_paid) : '-'}</dd>
            <dt>Metode</dt><dd>${esc(inv.payment_method)}</dd>
            <dt>Order</dt><dd>${inv.order_id ? `<a href="/admin/orders/${inv.order_id}">Order #${inv.order_id}</a>` : (inv.notes || '-')}</dd>
          </dl>
        </div></div>
      </div>`;
    await page(ctx, { title: 'Invoice ' + inv.invoice_num, active: '/admin/invoices', crumb: `<a href="/admin/invoices">Invoice</a> / <b>${esc(inv.invoice_num)}</b>`, body });
  });
  router.post('/admin/invoices/:id/pay', requireAdmin, requirePerm('manage_invoices'), async (ctx) => {
    await markInvoicePaid(Number(ctx.params.id));
    ctx.flash('success', 'Invoice ditandai lunas.');
    ctx.redirect('/admin/invoices/' + ctx.params.id);
  });
  router.post('/admin/invoices/:id/cancel', requireAdmin, requirePerm('manage_invoices'), async (ctx) => {
    await run("UPDATE invoices SET status='Cancelled' WHERE id=?", ctx.params.id);
    ctx.flash('info', 'Invoice dibatalkan.');
    ctx.redirect('/admin/invoices/' + ctx.params.id);
  });

  // ===================== SERVICES =====================
  router.get('/admin/services', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const status = ctx.query.status || '';
    const where = status ? 'WHERE s.status = ?' : '';
    const args = status ? [status] : [];
    const total = (await get(`SELECT COUNT(*) c FROM services s ${where}`, ...args)).c;
    const { page: pg, totalPages, perPage, offset } = paginate(ctx.query, total);
    const rows = await all(`SELECT s.*, c.first_name, c.last_name FROM services s JOIN clients c ON c.id=s.client_id ${where} ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...args, perPage, offset);
    const rowsHtml = rows.map((s) => `<tr>
      <td>${esc(s.name)}</td>
      <td><a href="/admin/clients/${s.client_id}">${esc(s.first_name + ' ' + (s.last_name || ''))}</a></td>
      <td>${esc(s.billing_cycle)}</td><td class="num">${rupiah(s.recurring_amount)}</td>
      <td class="nowrap">${s.next_due_date ? fmtDate(s.next_due_date) : '-'}</td><td>${badge(s.status)}</td>
      <td class="nowrap"><form method="post" action="/admin/services/${s.id}/status" style="display:inline">
        <select name="status" onchange="this.form.submit()" style="padding:.3rem;font-size:.78rem;width:auto">
          ${['Pending', 'Active', 'Suspended', 'Terminated', 'Cancelled'].map((st) => `<option ${st === s.status ? 'selected' : ''}>${st}</option>`).join('')}
        </select></form></td></tr>`).join('');
    const filter = (s, l) => `<a class="btn btn-sm ${status === s ? '' : 'btn-ghost'}" href="/admin/services${s ? '?status=' + s : ''}">${l}</a>`;
    const body = `
      <div class="page-head"><div><h1>Layanan Aktif</h1><div class="sub">${total} layanan</div></div></div>
      <div class="toolbar">${filter('', 'Semua')}${filter('Active', 'Aktif')}${filter('Pending', 'Pending')}${filter('Suspended', 'Suspend')}${filter('Terminated', 'Terminasi')}</div>
      ${tableCard('<th>Produk</th><th>Klien</th><th>Siklus</th><th class="num">Harga</th><th>Jatuh Tempo</th><th>Status</th><th>Ubah</th>', rowsHtml, 'Tidak ada layanan.')}
      ${pager('/admin/services', pg, totalPages, status ? '&status=' + status : '')}`;
    await page(ctx, { title: 'Layanan', active: '/admin/services', crumb: '<b>Layanan Aktif</b>', body });
  });
  router.post('/admin/services/:id/status', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const valid = ['Pending', 'Active', 'Suspended', 'Terminated', 'Cancelled'];
    if (valid.includes(ctx.body.status)) await run('UPDATE services SET status=? WHERE id=?', ctx.body.status, ctx.params.id);
    ctx.flash('success', 'Status layanan diperbarui.');
    ctx.redirect('/admin/services');
  });
  // WHMCS-style "Generate Due Invoices" shortcut: create renewal invoices for
  // active package services due within 7 days that don't already have an unpaid renewal invoice.
  router.post('/admin/services/generate-due', requireAdmin, requirePerm('manage_orders'), async (ctx) => {
    const due = await all(`SELECT * FROM services WHERE status='Active' AND type='package'
        AND next_due_date IS NOT NULL AND next_due_date <= CURDATE() + INTERVAL 7 DAY`);
    let generated = 0;
    for (const svc of due) {
      const pending = await get("SELECT id FROM invoices WHERE client_id=? AND notes='Renewal' AND status='Unpaid'", svc.client_id);
      if (pending) continue;
      if (await renewService(svc.id)) generated++;
    }
    ctx.flash('success', generated > 0 ? `${generated} invoice perpanjangan dibuat.` : 'Tidak ada layanan yang perlu invoice baru saat ini.');
    ctx.redirect('/admin/services');
  });

  // ===================== PRODUCTS =====================
  router.get('/admin/products', requireAdmin, requirePerm('manage_products'), async (ctx) => {
    const products = await all('SELECT * FROM products ORDER BY sort_order, id');
    const rows = products.map((p) => `<tr>
      <td><a href="/admin/products/${p.id}"><b>${esc(p.name)}</b></a><div class="muted" style="font-size:.75rem">${esc(p.tagline || '')}</div></td>
      <td>${p.type === 'addon' ? '<span class="badge badge-blue">Add-on</span>' : '<span class="tag-pill">Paket</span>'}</td>
      <td class="num">${p.type === 'addon' ? '-' : rupiah(p.setup_fee)}</td>
      <td class="num">${rupiah(p.price_3)}</td>
      <td class="num">${p.type === 'addon' ? '-' : rupiah(p.price_6)}</td>
      <td class="num">${p.type === 'addon' ? '-' : rupiah(p.price_12)}</td>
      <td>${badge(p.status)}</td>
      <td><a class="btn btn-ghost btn-sm" href="/admin/products/${p.id}">Edit</a></td></tr>`).join('');
    const body = `
      <div class="page-head"><div><h1>Produk &amp; Harga</h1><div class="sub">Paket OmsetAI &amp; add-on. Harga per periode.</div></div></div>
      <div class="alert alert-info">Add-on <b>Training User (One to One)</b> ditagih sekali (one-time), tanpa setup fee. Setup fee paket hanya berlaku pada pembelian pertama.</div>
      ${tableCard('<th>Produk</th><th>Tipe</th><th class="num">Setup Fee</th><th class="num">3 Bulan</th><th class="num">6 Bulan</th><th class="num">1 Tahun</th><th>Status</th><th></th>', rows)}`;
    await page(ctx, { title: 'Produk', active: '/admin/products', crumb: '<b>Produk &amp; Harga</b>', body });
  });
  router.get('/admin/products/:id', requireAdmin, requirePerm('manage_products'), async (ctx) => {
    const p = await get('SELECT * FROM products WHERE id = ?', ctx.params.id);
    if (!p) return ctx.notFound();
    const isAddon = p.type === 'addon';
    const body = `
      <div class="page-head"><div><h1>Edit: ${esc(p.name)}</h1><div class="sub">${isAddon ? 'Add-on (one-time)' : 'Paket langganan'}</div></div></div>
      <form method="post" action="/admin/products/${p.id}"><div class="card" style="max-width:720px"><div class="card-body">
        ${field('Nama Produk', 'name', p.name, { required: true })}
        ${field('Tagline', 'tagline', p.tagline)}
        ${field('Fitur (pisahkan dengan tanda |)', 'features', p.features, { textarea: true, help: 'Contoh: 2 WhatsApp number|5 Agent seats|Analytics' })}
        <div class="form-grid">
          ${isAddon ? field('Harga (one-time)', 'price_3', p.price_3, { type: 'number', help: 'Harga sekali bayar' }) : field('Setup Fee (one-time)', 'setup_fee', p.setup_fee, { type: 'number', help: 'Hanya pembelian pertama' })}
          ${isAddon ? '' : field('Harga 3 Bulan', 'price_3', p.price_3, { type: 'number' })}
          ${isAddon ? '' : field('Harga 6 Bulan', 'price_6', p.price_6, { type: 'number' })}
          ${isAddon ? '' : field('Harga 1 Tahun', 'price_12', p.price_12, { type: 'number' })}
        </div>
        ${field('Status', 'status', p.status, { select: ['Active', 'Hidden'].map((s) => ({ value: s, label: s })) })}
        <input type="hidden" name="is_addon" value="${isAddon ? '1' : '0'}">
        <button class="btn" type="submit">Simpan</button>
        <a class="btn btn-ghost" href="/admin/products">Batal</a>
      </div></div></form>`;
    await page(ctx, { title: 'Edit ' + p.name, active: '/admin/products', crumb: `<a href="/admin/products">Produk</a> / <b>${esc(p.name)}</b>`, body });
  });
  router.post('/admin/products/:id', requireAdmin, requirePerm('manage_products'), async (ctx) => {
    const b = ctx.body;
    const isAddon = b.is_addon === '1';
    const num = (v) => Math.max(0, parseInt(v) || 0);
    await run(`UPDATE products SET name=?, tagline=?, features=?, setup_fee=?, price_3=?, price_6=?, price_12=?, status=? WHERE id=?`,
      b.name, b.tagline || '', b.features || '',
      isAddon ? 0 : num(b.setup_fee), num(b.price_3), isAddon ? 0 : num(b.price_6), isAddon ? 0 : num(b.price_12),
      b.status || 'Active', ctx.params.id);
    ctx.flash('success', 'Produk diperbarui.');
    ctx.redirect('/admin/products/' + ctx.params.id);
  });

  // ===================== ADMIN ACCOUNTS =====================
  router.get('/admin/admins', requireAdmin, requirePerm('manage_admins'), async (ctx) => {
    const admins = await all('SELECT a.*, r.name AS role_name FROM admins a LEFT JOIN roles r ON r.id=a.role_id ORDER BY a.id');
    const rows = admins.map((a) => `<tr>
      <td><b>${esc(a.name)}</b><div class="muted" style="font-size:.75rem">@${esc(a.username)}</div></td>
      <td>${esc(a.email || '-')}</td>
      <td><span class="tag-pill">${esc(a.role_name || 'No role')}</span></td>
      <td>${badge(a.status)}</td>
      <td class="nowrap muted">${a.last_login ? fmtDateTime(a.last_login) : 'Belum pernah'}</td>
      <td><a class="btn btn-ghost btn-sm" href="/admin/admins/${a.id}">Edit</a></td></tr>`).join('');
    const body = `
      <div class="page-head"><div><h1>Akun Admin</h1><div class="sub">Kelola anggota tim administrasi</div></div>
        <a class="btn" href="/admin/admins/new">+ Tambah Admin</a></div>
      ${tableCard('<th>Nama</th><th>Email</th><th>Role</th><th>Status</th><th>Login Terakhir</th><th></th>', rows)}`;
    await page(ctx, { title: 'Akun Admin', active: '/admin/admins', crumb: '<b>Akun Admin</b>', body });
  });
  router.get('/admin/admins/new', requireAdmin, requirePerm('manage_admins'), async (ctx) => {
    await page(ctx, { title: 'Tambah Admin', active: '/admin/admins', crumb: '<a href="/admin/admins">Akun Admin</a> / <b>Tambah</b>', body: await adminForm({}, '/admin/admins/new', 'Tambah Admin') });
  });
  router.post('/admin/admins/new', requireAdmin, requirePerm('manage_admins'), async (ctx) => {
    const b = ctx.body;
    if (!b.username || !b.name || !b.password) { ctx.flash('error', 'Nama, username, dan password wajib.'); return ctx.redirect('/admin/admins/new'); }
    if (await get('SELECT id FROM admins WHERE username=?', b.username.trim())) { ctx.flash('error', 'Username sudah dipakai.'); return ctx.redirect('/admin/admins/new'); }
    await run('INSERT INTO admins (name,username,email,password,role_id,status,created_at) VALUES (?,?,?,?,?,?,?)',
      b.name.trim(), b.username.trim(), b.email || '', hashPassword(b.password), parseInt(b.role_id) || null, b.status || 'Active', nowISO());
    ctx.flash('success', 'Admin ditambahkan.');
    ctx.redirect('/admin/admins');
  });
  router.get('/admin/admins/:id', requireAdmin, requirePerm('manage_admins'), async (ctx) => {
    const a = await get('SELECT * FROM admins WHERE id=?', ctx.params.id);
    if (!a) return ctx.notFound();
    await page(ctx, { title: 'Edit Admin', active: '/admin/admins', crumb: `<a href="/admin/admins">Akun Admin</a> / <b>${esc(a.name)}</b>`, body: await adminForm(a, '/admin/admins/' + a.id, 'Simpan', ctx.admin) });
  });
  router.post('/admin/admins/:id', requireAdmin, requirePerm('manage_admins'), async (ctx) => {
    const a = await get('SELECT * FROM admins WHERE id=?', ctx.params.id);
    if (!a) return ctx.notFound();
    const b = ctx.body;
    await run('UPDATE admins SET name=?, email=?, role_id=?, status=? WHERE id=?',
      b.name || a.name, b.email || '', parseInt(b.role_id) || null, b.status || 'Active', a.id);
    if (b.password) await run('UPDATE admins SET password=? WHERE id=?', hashPassword(b.password), a.id);
    ctx.flash('success', 'Akun admin diperbarui.');
    ctx.redirect('/admin/admins/' + a.id);
  });
  router.post('/admin/admins/:id/delete', requireAdmin, requirePerm('manage_admins'), async (ctx) => {
    if (Number(ctx.params.id) === ctx.admin.id) { ctx.flash('error', 'Tidak bisa menghapus akun sendiri.'); return ctx.redirect('/admin/admins'); }
    const remaining = (await get("SELECT COUNT(*) c FROM admins WHERE status='Active'")).c;
    if (remaining <= 1) { ctx.flash('error', 'Minimal harus ada satu admin aktif.'); return ctx.redirect('/admin/admins'); }
    await run('DELETE FROM admins WHERE id=?', ctx.params.id);
    ctx.flash('success', 'Admin dihapus.');
    ctx.redirect('/admin/admins');
  });

  // ===================== ROLES =====================
  router.get('/admin/roles', requireAdmin, requirePerm('manage_roles'), async (ctx) => {
    const roles = await all('SELECT r.*, (SELECT COUNT(*) FROM admins a WHERE a.role_id=r.id) AS members FROM roles r ORDER BY r.id');
    const rows = roles.map((r) => {
      let perms = []; try { perms = JSON.parse(r.permissions); } catch {}
      return `<tr><td><b>${esc(r.name)}</b></td>
        <td>${r.name === 'Full Administrator' ? '<span class="badge badge-green">Semua izin</span>' : perms.map((p) => `<span class="tag-pill" style="margin:1px">${esc(PERM_LABELS[p] || p)}</span>`).join(' ') || '<span class="muted">Tidak ada</span>'}</td>
        <td class="num">${r.members}</td>
        <td><a class="btn btn-ghost btn-sm" href="/admin/roles/${r.id}">Edit</a></td></tr>`;
    }).join('');
    const body = `
      <div class="page-head"><div><h1>Role &amp; Hak Akses</h1><div class="sub">Atur izin per role administrasi</div></div>
        <a class="btn" href="/admin/roles/new">+ Tambah Role</a></div>
      ${tableCard('<th>Nama Role</th><th>Izin</th><th class="num">Anggota</th><th></th>', rows)}`;
    await page(ctx, { title: 'Role', active: '/admin/roles', crumb: '<b>Role &amp; Hak Akses</b>', body });
  });
  router.get('/admin/roles/new', requireAdmin, requirePerm('manage_roles'), async (ctx) => {
    await page(ctx, { title: 'Tambah Role', active: '/admin/roles', crumb: '<a href="/admin/roles">Role</a> / <b>Tambah</b>', body: roleForm({ permissions: '[]' }, '/admin/roles/new', 'Tambah Role') });
  });
  router.post('/admin/roles/new', requireAdmin, requirePerm('manage_roles'), async (ctx) => {
    const b = ctx.body;
    if (!b.name) { ctx.flash('error', 'Nama role wajib.'); return ctx.redirect('/admin/roles/new'); }
    const perms = ALL_PERMISSIONS.filter((p) => b['perm_' + p] === 'on');
    await run('INSERT INTO roles (name, permissions, created_at) VALUES (?,?,?)', b.name.trim(), JSON.stringify(perms), nowISO());
    ctx.flash('success', 'Role dibuat.');
    ctx.redirect('/admin/roles');
  });
  router.get('/admin/roles/:id', requireAdmin, requirePerm('manage_roles'), async (ctx) => {
    const r = await get('SELECT * FROM roles WHERE id=?', ctx.params.id);
    if (!r) return ctx.notFound();
    await page(ctx, { title: 'Edit Role', active: '/admin/roles', crumb: `<a href="/admin/roles">Role</a> / <b>${esc(r.name)}</b>`, body: roleForm(r, '/admin/roles/' + r.id, 'Simpan') });
  });
  router.post('/admin/roles/:id', requireAdmin, requirePerm('manage_roles'), async (ctx) => {
    const r = await get('SELECT * FROM roles WHERE id=?', ctx.params.id);
    if (!r) return ctx.notFound();
    const b = ctx.body;
    // Full Administrator always keeps all permissions.
    const perms = r.name === 'Full Administrator' ? ALL_PERMISSIONS : ALL_PERMISSIONS.filter((p) => b['perm_' + p] === 'on');
    await run('UPDATE roles SET name=?, permissions=? WHERE id=?', r.name === 'Full Administrator' ? r.name : (b.name || r.name), JSON.stringify(perms), r.id);
    ctx.flash('success', 'Role diperbarui.');
    ctx.redirect('/admin/roles/' + r.id);
  });
  router.post('/admin/roles/:id/delete', requireAdmin, requirePerm('manage_roles'), async (ctx) => {
    const r = await get('SELECT * FROM roles WHERE id=?', ctx.params.id);
    if (!r) return ctx.notFound();
    if (r.name === 'Full Administrator') { ctx.flash('error', 'Role Full Administrator tidak bisa dihapus.'); return ctx.redirect('/admin/roles'); }
    if ((await get('SELECT COUNT(*) c FROM admins WHERE role_id=?', r.id)).c > 0) { ctx.flash('error', 'Masih ada admin dengan role ini.'); return ctx.redirect('/admin/roles'); }
    await run('DELETE FROM roles WHERE id=?', r.id);
    ctx.flash('success', 'Role dihapus.');
    ctx.redirect('/admin/roles');
  });

  // ---------- form builders (need admin context) ----------
  function clientForm(c, action, submit) {
    return `<div class="page-head"><div><h1>${submit}</h1></div></div>
      <form method="post" action="${action}"><div class="card" style="max-width:760px"><div class="card-body">
        <div class="form-grid">
          ${field('Nama Depan', 'first_name', c.first_name, { required: true })}
          ${field('Nama Belakang', 'last_name', c.last_name)}
          ${field('Email', 'email', c.email, { type: 'email', required: true })}
          ${field('Password', 'password', '', { type: 'password', required: true })}
          ${field('Perusahaan', 'company', c.company)}
          ${field('No. HP', 'phone', c.phone)}
          ${field('Akun OmsetAI', 'sahabatai_account', c.sahabatai_account, { help: 'Email login di ai.indotrading.com' })}
          ${field('Kota', 'city', c.city)}
        </div>
        ${field('Alamat', 'address', c.address, { textarea: true })}
        ${field('Status', 'status', c.status || 'Active', { select: ['Active', 'Inactive', 'Closed'].map((s) => ({ value: s, label: s })) })}
        <button class="btn" type="submit">${submit}</button>
        <a class="btn btn-ghost" href="/admin/clients">Batal</a>
      </div></div></form>`;
  }
  async function adminForm(a, action, submit, currentAdmin) {
    const roles = await all('SELECT * FROM roles ORDER BY id');
    const roleOpts = roles.map((r) => ({ value: r.id, label: r.name }));
    const delBtn = (a.id && (!currentAdmin || currentAdmin.id !== a.id))
      ? `<form method="post" action="/admin/admins/${a.id}/delete" onsubmit="return confirm('Hapus admin ini?')" style="display:inline;margin-left:.5rem"><button class="btn btn-danger" type="submit">Hapus</button></form>` : '';
    return `<div class="page-head"><div><h1>${a.id ? 'Edit Admin' : 'Tambah Admin'}</h1></div></div>
      <form method="post" action="${action}"><div class="card" style="max-width:620px"><div class="card-body">
        ${field('Nama Lengkap', 'name', a.name, { required: true })}
        ${a.id ? `<div class="form-row"><label class="lbl">Username</label><input type="text" value="${esc(a.username)}" disabled><div class="help">Username tidak dapat diubah.</div></div>` : field('Username', 'username', a.username, { required: true })}
        ${field('Email', 'email', a.email, { type: 'email' })}
        ${field(a.id ? 'Password Baru (opsional)' : 'Password', 'password', '', { type: 'password', required: !a.id, help: a.id ? 'Kosongkan jika tidak diubah.' : '' })}
        ${field('Role', 'role_id', a.role_id, { select: roleOpts })}
        ${field('Status', 'status', a.status || 'Active', { select: ['Active', 'Disabled'].map((s) => ({ value: s, label: s })) })}
        <button class="btn" type="submit">${submit}</button>
        <a class="btn btn-ghost" href="/admin/admins">Batal</a>
        ${delBtn}
      </div></div></form>`;
  }
  function roleForm(r, action, submit) {
    let perms = []; try { perms = JSON.parse(r.permissions || '[]'); } catch {}
    const isFull = r.name === 'Full Administrator';
    const checks = ALL_PERMISSIONS.map((p) => `<label class="opt-card ${perms.includes(p) || isFull ? 'selected' : ''}" style="cursor:pointer">
      <input type="checkbox" name="perm_${p}" ${perms.includes(p) || isFull ? 'checked' : ''} ${isFull ? 'disabled' : ''}>
      <div><div class="opt-title">${esc(PERM_LABELS[p])}</div><div class="muted" style="font-size:.78rem">${esc(p)}</div></div></label>`).join('');
    return `<div class="page-head"><div><h1>${r.id ? 'Edit Role' : 'Tambah Role'}</h1>${isFull ? '<div class="sub">Role sistem — memiliki seluruh izin.</div>' : ''}</div></div>
      <form method="post" action="${action}"><div class="card" style="max-width:640px"><div class="card-body">
        ${isFull ? `<div class="form-row"><label class="lbl">Nama Role</label><input value="${esc(r.name)}" disabled></div>` : field('Nama Role', 'name', r.name, { required: true })}
        <label class="lbl">Hak Akses</label>
        ${checks}
        ${isFull ? '<div class="help">Izin Full Administrator tidak dapat diubah.</div>' : ''}
        <div style="margin-top:1rem"><button class="btn" type="submit">${submit}</button>
        <a class="btn btn-ghost" href="/admin/roles">Batal</a></div>
      </div></div></form>`;
  }
};
