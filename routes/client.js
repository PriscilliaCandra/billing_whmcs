'use strict';
// Public storefront + client area routes.
const { get, all, run } = require('../src/db');
const { publicLayout, esc, badge, rupiah, fmtDate, LOGO_SVG } = require('../src/views/ui');
const { authenticateClient, getClientById } = require('../src/services/auth');
const { hashPassword } = require('../src/lib/crypto');
const { createOrder, markInvoicePaid, renewService, isFirstPurchase, termPrice, TERM_LABELS } = require('../src/services/orders');
const { nowISO } = require('../src/lib/format');

// Demo credential hints only render when explicitly enabled — keep them off by
// default so a production/public deployment never displays login credentials.
const SHOW_DEMO_HINTS = process.env.SHOW_DEMO_HINTS === 'true';

async function requireClient(ctx) {
  if (!ctx.session.clientId) {
    ctx.session.afterLogin = ctx.req.url;
    ctx.redirect('/login');
    return 'STOP';
  }
  const client = await getClientById(ctx.session.clientId);
  if (!client) { ctx.session.clientId = null; ctx.redirect('/login'); return 'STOP'; }
  ctx.client = client;
}

const TERMS = [{ n: 3, label: '3 Bulan' }, { n: 6, label: '6 Bulan' }, { n: 12, label: '1 Tahun' }];

module.exports = function registerClient(router) {
  // ===================== STOREFRONT =====================
  router.get('/', async (ctx) => {
    const client = ctx.session.clientId ? await getClientById(ctx.session.clientId) : null;
    const packages = await all("SELECT * FROM products WHERE type='package' AND status='Active' ORDER BY sort_order");
    const addon = await get("SELECT * FROM products WHERE slug='training-user'");

    const plans = packages.map((p, idx) => {
      const feats = (p.features || '').split('|').filter(Boolean);
      const featured = p.slug === 'growth';
      return `<div class="plan ${featured ? 'featured' : ''}">
        ${featured ? '<div class="tag-pill" style="align-self:flex-start;background:rgba(127,220,180,.2);color:#7fdcb4;margin-bottom:.5rem">PALING POPULER</div>' : ''}
        <div class="plan-name">${esc(p.name)}</div>
        <div class="price" data-p3="${p.price_3}" data-p6="${p.price_6}" data-p12="${p.price_12}">${rupiah(p.price_12)}<small> / 1 tahun</small></div>
        <div class="plan-sub">${esc(p.tagline || '')}</div>
        <ul class="feat">${feats.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="setup-note">+ Setup fee ${rupiah(p.setup_fee)} (sekali, pembelian pertama)</div>
        <a href="/order?plan=${esc(p.slug)}&term=12" class="btn btn-block ${featured ? 'btn-dark' : ''}" style="margin-top:1rem" data-order="${esc(p.slug)}">Pesan Sekarang</a>
      </div>`;
    }).join('');

    const body = `
    <div class="public-wrap">
      <div class="hero">
        <h1>Harga OmsetAI</h1>
        <p>Pilih paket WhatsApp AI CRM sesuai skala bisnis Anda. Bayar per 3 bulan, 6 bulan, atau 1 tahun.</p>
        <div class="note">🔒 Wajib punya akun OmsetAI dulu — daftar di <a href="https://ai.indotrading.com/" target="_blank" style="text-decoration:underline">ai.indotrading.com</a>, lalu order di sini.</div>
        <div><div class="term-toggle" id="termToggle">
          ${TERMS.map((t) => `<button data-term="${t.n}" class="${t.n === 12 ? 'active' : ''}">${t.label}</button>`).join('')}
        </div></div>
      </div>
      <div class="pricing">${plans}</div>

      <div class="card mt" style="margin-top:2.5rem"><div class="card-body" style="display:flex;gap:1.5rem;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:240px">
          <div class="tag-pill">ADD-ON</div>
          <h3 style="margin:.4rem 0">${esc(addon.name)}</h3>
          <p class="muted" style="margin:0">${esc(addon.tagline)}</p>
        </div>
        <div class="right"><div style="font-size:1.4rem;font-weight:800;color:var(--green-700)">${rupiah(addon.price_3)}<small style="font-weight:600;color:var(--muted)"> / sesi</small></div>
        <div class="muted" style="font-size:.8rem">Bisa ditambahkan saat checkout paket</div></div>
      </div></div>

      <div style="text-align:center;margin-top:2.5rem" class="muted">
        Sudah punya layanan? <a href="/clientarea">Masuk ke Client Area</a> untuk kelola langganan &amp; bayar invoice.
      </div>
    </div>
    <script>
      (function(){
        var toggle=document.getElementById('termToggle');
        var termLabels={3:'3 bulan',6:'6 bulan',12:'1 tahun'};
        toggle.addEventListener('click',function(e){
          var b=e.target.closest('button'); if(!b)return;
          var term=b.getAttribute('data-term');
          toggle.querySelectorAll('button').forEach(function(x){x.classList.remove('active')});
          b.classList.add('active');
          document.querySelectorAll('.price').forEach(function(el){
            var v=el.getAttribute('data-p'+term);
            var n=Number(v).toLocaleString('id-ID');
            el.innerHTML='Rp '+n+'<small> / '+termLabels[term]+'</small>';
          });
          document.querySelectorAll('[data-order]').forEach(function(a){
            a.href='/order?plan='+a.getAttribute('data-order')+'&term='+term;
          });
        });
      })();
    </script>`;
    ctx.html(publicLayout({ title: 'Harga', body, client }));
  });

  // ===================== AUTH (client) =====================
  router.get('/register', (ctx) => {
    if (ctx.session.clientId) return ctx.redirect('/clientarea');
    ctx.html(publicLayout({ title: 'Daftar', body: registerForm(ctx, {}), client: null }));
  });
  router.post('/register', async (ctx) => {
    const b = ctx.body;
    if (!b.confirm_sahabat) { ctx.flash('error', 'Anda harus sudah memiliki akun OmsetAI terlebih dahulu.'); ctx.session._form = b; return ctx.redirect('/register'); }
    if (!b.first_name || !b.email || !b.password) { ctx.flash('error', 'Lengkapi nama, email, dan password.'); return ctx.redirect('/register'); }
    if (await get('SELECT id FROM clients WHERE email=?', b.email.trim())) { ctx.flash('error', 'Email sudah terdaftar. Silakan masuk.'); return ctx.redirect('/login'); }
    const res = await run(`INSERT INTO clients (first_name,last_name,email,password,company,phone,sahabatai_account,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      b.first_name.trim(), (b.last_name || '').trim(), b.email.trim(), hashPassword(b.password),
      b.company || '', b.phone || '', b.email.trim(), 'Active', nowISO());
    ctx.session.clientId = Number(res.insertId);
    ctx.flash('success', 'Akun berhasil dibuat. Selamat datang!');
    ctx.redirect(ctx.session.afterLogin || '/clientarea');
    ctx.session.afterLogin = null;
  });

  router.get('/login', (ctx) => {
    if (ctx.session.clientId) return ctx.redirect('/clientarea');
    ctx.html(publicLayout({ title: 'Masuk', body: loginForm(ctx, ''), client: null }));
  });
  router.post('/login', async (ctx) => {
    const client = await authenticateClient((ctx.body.email || '').trim(), ctx.body.password || '');
    if (!client) return ctx.html(publicLayout({ title: 'Masuk', body: loginForm(ctx, 'Email atau password salah.'), client: null }));
    if (client.status !== 'Active') return ctx.html(publicLayout({ title: 'Masuk', body: loginForm(ctx, 'Akun tidak aktif. Hubungi admin.'), client: null }));
    ctx.session.clientId = client.id;
    const next = ctx.session.afterLogin || '/clientarea';
    ctx.session.afterLogin = null;
    ctx.redirect(next);
  });
  router.get('/logout', (ctx) => { ctx.session.clientId = null; ctx.redirect('/'); });

  // ===================== CHECKOUT (cart.php equivalent) =====================
  router.get('/order', requireClient, async (ctx) => {
    const slug = ctx.query.plan;
    const term = [3, 6, 12].includes(Number(ctx.query.term)) ? Number(ctx.query.term) : 12;
    const pkg = await get("SELECT * FROM products WHERE slug=? AND type='package'", slug);
    if (!pkg) { ctx.flash('error', 'Paket tidak ditemukan.'); return ctx.redirect('/'); }
    const addon = await get("SELECT * FROM products WHERE slug='training-user'");
    const first = await isFirstPurchase(ctx.client.id, pkg.id);
    ctx.html(publicLayout({ title: 'Checkout', body: checkoutForm(ctx, pkg, term, addon, first), client: ctx.client }));
  });
  router.post('/order', requireClient, async (ctx) => {
    const b = ctx.body;
    const pkg = await get('SELECT * FROM products WHERE id=?', b.package_id);
    if (!pkg) { ctx.flash('error', 'Paket tidak valid.'); return ctx.redirect('/'); }
    const term = [3, 6, 12].includes(Number(b.term)) ? Number(b.term) : 12;
    const addons = [];
    if (b.addon_training === 'on') {
      const addon = await get("SELECT * FROM products WHERE slug='training-user'");
      const qty = Math.max(1, parseInt(b.addon_qty) || 1);
      if (addon) addons.push({ id: addon.id, qty });
    }
    const { order, invoice } = await createOrder(ctx.client.id, { packageId: pkg.id, term, addons });
    ctx.flash('success', `Order ${order.order_num} dibuat. Silakan lakukan pembayaran invoice.`);
    ctx.redirect('/clientarea/invoices/' + invoice.id);
  });

  // ===================== CLIENT AREA =====================
  router.get('/clientarea', requireClient, async (ctx) => {
    const c = ctx.client;
    const services = await all("SELECT * FROM services WHERE client_id=? AND type='package' ORDER BY id DESC", c.id);
    const invoices = await all('SELECT * FROM invoices WHERE client_id=? ORDER BY id DESC LIMIT 10', c.id);
    const dueTotal = (await get("SELECT COALESCE(SUM(total),0) s FROM invoices WHERE client_id=? AND status='Unpaid'", c.id)).s;

    const svcRows = services.map((s) => `<tr>
      <td><b>${esc(s.name)}</b></td><td>${esc(s.billing_cycle)}</td>
      <td class="num">${rupiah(s.recurring_amount)}</td>
      <td class="nowrap">${s.next_due_date ? fmtDate(s.next_due_date) : '-'}</td><td>${badge(s.status)}</td>
      <td>${s.status === 'Active' ? `<form method="post" action="/clientarea/services/${s.id}/renew" style="display:inline"><button class="btn btn-sm btn-outline">Perpanjang</button></form>` : ''}</td></tr>`).join('');
    const invRows = invoices.map((i) => `<tr>
      <td><a href="/clientarea/invoices/${i.id}">${esc(i.invoice_num)}</a></td>
      <td class="nowrap">${fmtDate(i.date_created)}</td><td class="num">${rupiah(i.total)}</td><td>${badge(i.status)}</td>
      <td>${i.status === 'Unpaid' ? `<a class="btn btn-sm" href="/clientarea/invoices/${i.id}">Bayar</a>` : `<a class="btn btn-ghost btn-sm" href="/clientarea/invoices/${i.id}">Lihat</a>`}</td></tr>`).join('');

    const body = `
    <div class="client-header"><div class="inner">
      <div><div style="display:flex;align-items:center;gap:.5rem;color:#bfe0d1;font-size:.85rem"><span style="width:28px;height:28px;border-radius:50%;background:var(--green);display:grid;place-items:center">${LOGO_SVG}</span>Client Area</div>
      <h1 style="color:#fff;margin:.3rem 0 0">Halo, ${esc(c.first_name)} 👋</h1><div style="color:#bfe0d1">${esc(c.company || c.email)}</div></div>
      <div class="right"><div style="color:#bfe0d1;font-size:.8rem">Tagihan belum dibayar</div><div style="font-size:1.5rem;font-weight:800;color:#fff">${rupiah(dueTotal)}</div>
      <a href="/" class="btn btn-sm" style="margin-top:.5rem">+ Beli Paket Lagi</a></div>
    </div></div>
    <div class="client-wrap">
      ${flashClient(ctx)}
      <div class="card"><div class="card-head"><h3>Layanan Saya</h3><a href="/" class="muted" style="font-size:.8rem">+ Tambah layanan</a></div>
        ${services.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>Produk</th><th>Siklus</th><th class="num">Harga</th><th>Jatuh Tempo</th><th>Status</th><th></th></tr></thead><tbody>${svcRows}</tbody></table></div>` : '<div class="card-body muted">Belum ada layanan. <a href="/">Pesan paket pertama Anda →</a></div>'}
      </div>
      <div class="card mt"><div class="card-head"><h3>Invoice Saya</h3></div>
        ${invoices.length ? `<div class="table-wrap"><table class="data"><thead><tr><th>No.</th><th>Tanggal</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>${invRows}</tbody></table></div>` : '<div class="card-body muted">Belum ada invoice.</div>'}
      </div>
      <div style="margin-top:1.5rem"><a href="/clientarea/profile" class="btn btn-outline">Edit Profil</a> <a href="/logout" class="btn btn-ghost">Keluar</a></div>
    </div>`;
    ctx.html(publicLayout({ title: 'Client Area', body, client: c }));
  });

  router.get('/clientarea/profile', requireClient, async (ctx) => {
    const c = ctx.client;
    const body = `<div class="center-wide">
      ${flashClient(ctx)}
      <h1>Edit Profil</h1>
      <form method="post" action="/clientarea/profile"><div class="card"><div class="card-body">
        <div class="form-grid">
          <div class="form-row"><label class="lbl">Nama Depan</label><input name="first_name" value="${esc(c.first_name)}" required></div>
          <div class="form-row"><label class="lbl">Nama Belakang</label><input name="last_name" value="${esc(c.last_name || '')}"></div>
          <div class="form-row"><label class="lbl">Perusahaan</label><input name="company" value="${esc(c.company || '')}"></div>
          <div class="form-row"><label class="lbl">No. HP</label><input name="phone" value="${esc(c.phone || '')}"></div>
        </div>
        <div class="form-row"><label class="lbl">Password Baru (opsional)</label><input type="password" name="password"><div class="help">Kosongkan jika tidak diubah.</div></div>
        <button class="btn" type="submit">Simpan</button> <a href="/clientarea" class="btn btn-ghost">Kembali</a>
      </div></div></form></div>`;
    ctx.html(publicLayout({ title: 'Profil', body, client: c }));
  });
  router.post('/clientarea/profile', requireClient, async (ctx) => {
    const b = ctx.body; const c = ctx.client;
    await run('UPDATE clients SET first_name=?, last_name=?, company=?, phone=? WHERE id=?',
      b.first_name || c.first_name, b.last_name || '', b.company || '', b.phone || '', c.id);
    if (b.password) await run('UPDATE clients SET password=? WHERE id=?', hashPassword(b.password), c.id);
    ctx.flash('success', 'Profil diperbarui.');
    ctx.redirect('/clientarea/profile');
  });

  router.get('/clientarea/invoices/:id', requireClient, async (ctx) => {
    const inv = await get('SELECT * FROM invoices WHERE id=? AND client_id=?', ctx.params.id, ctx.client.id);
    if (!inv) return ctx.notFound('Invoice tidak ditemukan');
    const items = await all('SELECT * FROM invoice_items WHERE invoice_id=?', inv.id);
    const itemRows = items.map((it) => `<tr><td>${esc(it.description)}</td><td class="num">${rupiah(it.amount)}</td></tr>`).join('');
    const body = `<div class="center-wide">
      ${flashClient(ctx)}
      <a href="/clientarea" class="muted">← Client Area</a>
      <div class="card mt"><div class="card-body">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:1.5rem">
          <div><b style="font-size:1.2rem;color:var(--green-dark)">Invoice ${esc(inv.invoice_num)}</b><div class="muted">Tanggal ${fmtDate(inv.date_created)}</div></div>
          <div>${badge(inv.status)}</div>
        </div>
        <table class="data" style="border:1px solid var(--line);border-radius:8px;overflow:hidden"><thead><tr><th>Deskripsi</th><th class="num">Jumlah</th></tr></thead>
          <tbody>${itemRows}<tr><td class="right"><b>Total</b></td><td class="num"><b>${rupiah(inv.total)}</b></td></tr></tbody></table>
        ${inv.status === 'Unpaid' ? `
          <div class="card mt" style="background:#f7faf8"><div class="card-body">
            <h3 style="margin-top:0">Pembayaran</h3>
            <p class="muted">Transfer ke <b>BCA 123-456-7890</b> a.n. PT Indotrading, atau klik tombol di bawah untuk simulasi pembayaran (demo).</p>
            <form method="post" action="/clientarea/invoices/${inv.id}/pay"><button class="btn btn-block" type="submit">Bayar Sekarang (Simulasi) — ${rupiah(inv.total)}</button></form>
          </div></div>` : inv.status === 'Paid' ? '<div class="alert alert-success mt">Invoice ini sudah LUNAS. Terima kasih!</div>' : ''}
      </div></div>
    </div>`;
    ctx.html(publicLayout({ title: 'Invoice ' + inv.invoice_num, body, client: ctx.client }));
  });
  router.post('/clientarea/invoices/:id/pay', requireClient, async (ctx) => {
    const inv = await get('SELECT * FROM invoices WHERE id=? AND client_id=?', ctx.params.id, ctx.client.id);
    if (!inv) return ctx.notFound();
    await markInvoicePaid(inv.id);
    ctx.flash('success', 'Pembayaran berhasil! Layanan Anda telah diaktifkan.');
    ctx.redirect('/clientarea/invoices/' + inv.id);
  });
  router.post('/clientarea/services/:id/renew', requireClient, async (ctx) => {
    const svc = await get('SELECT * FROM services WHERE id=? AND client_id=?', ctx.params.id, ctx.client.id);
    if (!svc) return ctx.notFound();
    const inv = await renewService(svc.id);
    if (inv) { ctx.flash('success', 'Invoice perpanjangan dibuat (tanpa setup fee). Silakan bayar.'); ctx.redirect('/clientarea/invoices/' + inv.id); }
    else { ctx.flash('error', 'Layanan tidak bisa diperpanjang.'); ctx.redirect('/clientarea'); }
  });

  // ---------- view builders ----------
  function flashClient(ctx) {
    if (!ctx.session.flash) return '';
    const f = ctx.session.flash; delete ctx.session.flash;
    const cls = f.type === 'error' ? 'alert-error' : f.type === 'info' ? 'alert-info' : 'alert-success';
    return `<div class="alert ${cls}">${esc(f.msg)}</div>`;
  }
  function registerForm(ctx, v) {
    const f = ctx.session._form || {}; ctx.session._form = null;
    return `<div class="center-narrow">
      ${flashClient(ctx)}
      <div class="auth-card">
        <div class="logo-lg">${LOGO_SVG}</div>
        <h2 style="text-align:center">Daftar Akun Billing</h2>
        <div class="alert alert-info" style="font-size:.82rem">Wajib punya akun OmsetAI dulu. Belum punya? <a href="https://ai.indotrading.com/" target="_blank">Daftar di ai.indotrading.com</a> lalu kembali ke sini.</div>
        <form method="post" action="/register">
          <div class="form-grid">
            <div class="form-row"><label class="lbl">Nama Depan</label><input name="first_name" value="${esc(f.first_name || '')}" required></div>
            <div class="form-row"><label class="lbl">Nama Belakang</label><input name="last_name" value="${esc(f.last_name || '')}"></div>
          </div>
          <div class="form-row"><label class="lbl">Email (sama dengan akun OmsetAI)</label><input type="email" name="email" value="${esc(f.email || '')}" required></div>
          <div class="form-grid">
            <div class="form-row"><label class="lbl">Perusahaan</label><input name="company" value="${esc(f.company || '')}"></div>
            <div class="form-row"><label class="lbl">No. HP</label><input name="phone" value="${esc(f.phone || '')}"></div>
          </div>
          <div class="form-row"><label class="lbl">Password</label><input type="password" name="password" required></div>
          <label class="opt-card" style="cursor:pointer"><input type="checkbox" name="confirm_sahabat"><div><div class="opt-title">Saya sudah punya akun OmsetAI</div><div class="muted" style="font-size:.78rem">Terdaftar di ai.indotrading.com</div></div></label>
          <button class="btn btn-block" type="submit" style="margin-top:.5rem">Daftar &amp; Lanjut</button>
        </form>
        <p style="text-align:center;margin-top:1rem">Sudah punya akun? <a href="/login">Masuk</a></p>
      </div></div>`;
  }
  function loginForm(ctx, error) {
    return `<div class="center-narrow">
      ${flashClient(ctx)}
      <div class="auth-card">
        <div class="logo-lg">${LOGO_SVG}</div>
        <h2 style="text-align:center">Masuk</h2>
        <p class="muted" style="text-align:center;margin-top:0">Client Area OmsetAI Billing</p>
        ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
        <form method="post" action="/login">
          <div class="form-row"><label class="lbl">Email</label><input type="email" name="email" required autofocus></div>
          <div class="form-row"><label class="lbl">Password</label><input type="password" name="password" required></div>
          <button class="btn btn-block" type="submit">Masuk</button>
        </form>
        ${SHOW_DEMO_HINTS ? '<p class="muted" style="text-align:center;font-size:.78rem;margin-top:1rem">Demo: <b>demo@client.com</b> / <b>demo123</b></p>' : ''}
        <p style="text-align:center;margin-top:.5rem">Belum punya akun? <a href="/register">Daftar</a></p>
      </div></div>`;
  }
  function checkoutForm(ctx, pkg, term, addon, first) {
    const price = termPrice(pkg, term);
    const setup = first ? pkg.setup_fee : 0;
    const feats = (pkg.features || '').split('|').filter(Boolean);
    return `<div class="public-wrap">
      ${flashClient(ctx)}
      <a href="/" class="muted">← Semua paket</a>
      <h1 style="margin-top:.5rem">Checkout — OmsetAI ${esc(pkg.name)}</h1>
      <form method="post" action="/order" id="checkoutForm"><div class="checkout-grid">
        <div>
          <div class="card"><div class="card-head"><h3>Pilih Periode</h3></div><div class="card-body">
            ${TERMS.map((t) => `<label class="opt-card ${t.n === term ? 'selected' : ''}">
              <input type="radio" name="term" value="${t.n}" ${t.n === term ? 'checked' : ''} data-price="${termPrice(pkg, t.n)}">
              <div><div class="opt-title">${t.label}</div><div class="muted" style="font-size:.8rem">Langganan ${esc(pkg.name)}</div></div>
              <div class="opt-price">${rupiah(termPrice(pkg, t.n))}</div></label>`).join('')}
          </div></div>

          <div class="card mt"><div class="card-head"><h3>Add-on (opsional)</h3></div><div class="card-body">
            <label class="opt-card" id="addonCard">
              <input type="checkbox" name="addon_training" id="addonCheck" data-price="${addon.price_3}">
              <div style="flex:1"><div class="opt-title">${esc(addon.name)}</div><div class="muted" style="font-size:.8rem">${esc(addon.tagline)}</div>
                <div style="margin-top:.5rem;display:none" id="qtyWrap">Jumlah sesi: <input type="number" name="addon_qty" value="1" min="1" style="width:80px;display:inline-block;padding:.3rem"></div>
              </div>
              <div class="opt-price">${rupiah(addon.price_3)}<small style="color:var(--muted)"> / sesi</small></div></label>
          </div></div>

          <div class="card mt"><div class="card-body">
            <b>Termasuk di paket ${esc(pkg.name)}:</b>
            <ul style="columns:2;margin:.5rem 0 0;padding-left:1.2rem;font-size:.85rem">${feats.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
          </div></div>
        </div>

        <div class="card summary"><div class="card-head"><h3>Ringkasan</h3></div><div class="card-body">
          <div class="line"><span>Paket ${esc(pkg.name)} <span id="termLabel">(${TERM_LABELS[term]})</span></span><b id="sumPrice">${rupiah(price)}</b></div>
          <div class="line" id="setupLine">${setup > 0 ? `<span>Setup fee (sekali)</span><b>${rupiah(setup)}</b>` : `<span class="muted">Setup fee</span><b class="muted">Rp 0 — perpanjangan</b>`}</div>
          <div class="line" id="addonLine" style="display:none"><span>Training User <span id="addonQtyLabel"></span></span><b id="sumAddon">Rp 0</b></div>
          <div class="line total"><span>Total</span><span id="sumTotal">${rupiah(price + setup)}</span></div>
          <input type="hidden" name="package_id" value="${pkg.id}">
          <button class="btn btn-block" type="submit" style="margin-top:1rem">Buat Order &amp; Invoice</button>
          <p class="muted" style="font-size:.76rem;text-align:center;margin-top:.75rem">Setup fee ${first ? '<b>berlaku</b> (pembelian pertama)' : 'tidak berlaku (perpanjangan)'}.</p>
        </div></div>
      </div></form>
    </div>
    <script>
      (function(){
        var setup=${setup}, addonPrice=${addon.price_3};
        var terms={3:'3 Bulan',6:'6 Bulan',12:'1 Tahun'};
        function fmt(n){return 'Rp '+Number(n).toLocaleString('id-ID');}
        function recalc(){
          var termEl=document.querySelector('input[name=term]:checked');
          var price=Number(termEl.getAttribute('data-price'));
          document.getElementById('sumPrice').textContent=fmt(price);
          document.getElementById('termLabel').textContent='('+terms[termEl.value]+')';
          var addon=0;
          var check=document.getElementById('addonCheck');
          var qty=Math.max(1,parseInt(document.querySelector('[name=addon_qty]').value)||1);
          if(check.checked){ addon=addonPrice*qty;
            document.getElementById('addonLine').style.display='flex';
            document.getElementById('qtyWrap').style.display='block';
            document.getElementById('sumAddon').textContent=fmt(addon);
            document.getElementById('addonQtyLabel').textContent='x'+qty;
          } else { document.getElementById('addonLine').style.display='none'; document.getElementById('qtyWrap').style.display='none'; }
          document.getElementById('sumTotal').textContent=fmt(price+setup+addon);
        }
        document.querySelectorAll('input[name=term]').forEach(function(r){r.addEventListener('change',function(){
          document.querySelectorAll('input[name=term]').forEach(function(x){x.closest('.opt-card').classList.remove('selected')});
          r.closest('.opt-card').classList.add('selected'); recalc();
        })});
        document.getElementById('addonCheck').addEventListener('change',function(){this.closest('.opt-card').classList.toggle('selected',this.checked);recalc()});
        document.querySelector('[name=addon_qty]').addEventListener('input',recalc);
        recalc();
      })();
    </script>`;
  }
};
