'use strict';
// Shared HTML rendering helpers (no template engine — plain string builders).
const { rupiah, fmtDate, fmtDateTime } = require('../lib/format');
const { get, all } = require('../db');

function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Inline SVG logo mark used across public + admin.
const LOGO_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.5 2 2 5.9 2 10.7c0 2.7 1.4 5.1 3.6 6.7L4.8 22l4.4-2.3c.9.2 1.8.3 2.8.3 5.5 0 10-3.9 10-8.7S17.5 2 12 2Z" fill="currentColor"/></svg>`;

// === REBRAND: wordmark lockup === mirror the app sidebar / landing page lockup:
// small accent-colored rounded-square icon (chat bubble) + "Omset" in ink/white
// + bold "AI" in accent color. Used anywhere the app previously printed a plain
// "OmsetAI" brand string.
const BRAND_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`;
function brandMark({ size = 28, textSize = '1.05rem', textColor = 'inherit', weight = 800 } = {}) {
  return `<span style="display:inline-flex;align-items:center;gap:.5rem;">` +
    `<span style="width:${size}px;height:${size}px;border-radius:8px;background:var(--green);display:inline-flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;">${BRAND_ICON_SVG}</span>` +
    `<span style="font-weight:${weight};font-size:${textSize};color:${textColor};">Omset<span style="color:var(--green);">AI</span></span>` +
    `</span>`;
}
const BRAND_MARK = brandMark();

// === REBRAND: hapus emoji/icon berwarna === set ikon garis monokrom (stroke=
// currentColor, gaya sama seperti LOGO_SVG) menggantikan emoji pictograph
// (🛒🧾📄👤🔒⏰✓↻) di seluruh app — supaya tampilan konsisten profesional,
// warna ikon ikut warna teks/kontainer di sekitarnya (tidak berwarna sendiri).
function icon(paths, vb = 24) {
  return (size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">${paths}</svg>`;
}
const ICON = {
  user:    icon('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  cart:    icon('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'),
  receipt: icon('<path d="M4 2h16v20l-3-2-2 2-2-2-2 2-2-2-2 2-3-2Z"/><path d="M8 7h8M8 11h8M8 15h5"/>'),
  file:    icon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>'),
  clock:   icon('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  lock:    icon('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  check:   icon('<path d="M20 6 9 17l-5-5"/>'),
  refresh: icon('<path d="M21 12a9 9 0 0 1-15.3 6.4M3 12a9 9 0 0 1 15.3-6.4"/><path d="M21 3v6h-6M3 21v-6h6"/>'),
};

const STATUS_BADGE = {
  Active: 'badge-green', Paid: 'badge-green', Completed: 'badge-green',
  Pending: 'badge-amber', Unpaid: 'badge-amber', Suspended: 'badge-amber',
  Cancelled: 'badge-gray', Terminated: 'badge-gray', Inactive: 'badge-gray', Closed: 'badge-gray',
  Fraud: 'badge-red', Refunded: 'badge-blue', Overdue: 'badge-red',
};
function badge(status) {
  const cls = STATUS_BADGE[status] || 'badge-gray';
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function flash(session) {
  if (!session || !session.flash) return '';
  const f = session.flash;
  delete session.flash;
  const cls = f.type === 'error' ? 'alert-error' : f.type === 'info' ? 'alert-info' : 'alert-success';
  return `<div class="alert ${cls}">${esc(f.msg)}</div>`;
}

function hasPerm(admin, perm) {
  if (!perm) return true;
  if (admin.isFull || admin.roleName === 'Full Administrator') return true;
  const need = Array.isArray(perm) ? perm : [perm];
  return need.some((p) => (admin.permissions || []).includes(p));
}

// ---- Top navigation (WHMCS-style dropdown menus) ----
const TOP_NAV = [
  { href: '/admin', label: 'Dashboard', match: '/admin', exact: true },
  {
    label: 'Clients', match: '/admin/clients', perm: 'manage_clients',
    items: [
      { href: '/admin/clients', label: 'View/Search Clients' },
      { href: '/admin/clients/new', label: '+ Add New Client' },
    ],
  },
  {
    label: 'Orders', match: '/admin/orders', perm: 'manage_orders',
    items: [
      { href: '/admin/orders', label: 'List All Orders' },
      { href: '/admin/orders?status=Pending', label: '— Pending Orders' },
      { href: '/admin/orders?status=Active', label: '— Active Orders' },
      { href: '/admin/orders?status=Cancelled', label: '— Cancelled Orders' },
      { href: '/admin/orders/new', label: '+ Add New Order' },
    ],
  },
  {
    label: 'Billing', match: '/admin/invoices', perm: 'manage_invoices',
    items: [
      { href: '/admin/invoices', label: 'List All Invoices' },
      { href: '/admin/invoices?status=Unpaid', label: '— Unpaid Invoices' },
      { href: '/admin/invoices?status=Paid', label: '— Paid Invoices' },
      { href: '/admin/services', label: 'Layanan Aktif' },
    ],
  },
  {
    label: 'Produk', match: '/admin/products', perm: 'manage_products',
    items: [{ href: '/admin/products', label: 'Produk & Harga' }],
  },
  {
    label: 'Setup', match: '/admin/admins,/admin/roles', perm: ['manage_admins', 'manage_roles'],
    items: [
      { href: '/admin/admins', label: 'Akun Admin', perm: 'manage_admins' },
      { href: '/admin/admins/new', label: '+ Add New Admin', perm: 'manage_admins' },
      { href: '/admin/roles', label: 'Role & Hak Akses', perm: 'manage_roles' },
    ],
  },
];

async function getTopAlerts() {
  const pendingOrders = (await get("SELECT COUNT(*) c FROM orders WHERE status='Pending'")).c;
  const unpaidInvoices = (await get("SELECT COUNT(*) c FROM invoices WHERE status='Unpaid'")).c;
  const expiring = (await get(`SELECT COUNT(*) c FROM services WHERE status='Active' AND type='package'
      AND next_due_date IS NOT NULL AND next_due_date <= CURDATE() + INTERVAL 7 DAY`)).c;
  return { pendingOrders, unpaidInvoices, expiring };
}

async function topNavbar(active, admin) {
  const alerts = await getTopAlerts();
  const items = TOP_NAV.filter((item) => hasPerm(admin, item.perm)).map((item) => {
    const matches = item.match.split(',');
    const isActive = item.exact ? active === item.href : matches.some((m) => active.startsWith(m));
    if (!item.items) {
      return `<a href="${item.href}" class="wh-nav-link ${isActive ? 'active' : ''}">${esc(item.label)}</a>`;
    }
    const subItems = item.items.filter((si) => hasPerm(admin, si.perm));
    if (!subItems.length) return '';
    return `<div class="wh-dropdown">
      <button type="button" class="wh-nav-link ${isActive ? 'active' : ''}">${esc(item.label)} <span class="caret">▾</span></button>
      <div class="wh-dropdown-menu">${subItems.map((si) => `<a href="${si.href}">${esc(si.label)}</a>`).join('')}</div>
    </div>`;
  }).join('');

  return `
  <div class="wh-utility">
    <div class="wh-utility-left">
      <a href="/" target="_blank">Home</a>
      <a href="/clientarea" target="_blank">Client Area</a>
      <a href="/admin/myaccount">My Account</a>
      <a href="/admin/logout">Logout</a>
    </div>
    <div class="wh-utility-right">
      ${alerts.pendingOrders} Order Pending &nbsp;|&nbsp;
      ${alerts.unpaidInvoices} Invoice Belum Dibayar &nbsp;|&nbsp;
      ${alerts.expiring} Layanan Segera Jatuh Tempo
      <span class="wh-clock" id="whClock"></span>
    </div>
  </div>
  <div class="wh-navbar">
    <a href="/admin" class="wh-brand">${brandMark({ size: 26, textSize: '1.05rem', textColor: '#fff' })}</a>
    <nav class="wh-navitems">${items}</nav>
    <form class="wh-search" method="get" action="/admin/clients">
      <input type="text" name="q" placeholder="Cari klien…">
    </form>
  </div>
  <script>
    (function(){
      document.querySelectorAll('.wh-dropdown > button').forEach(function(btn){
        btn.addEventListener('click', function(e){
          e.stopPropagation();
          var open = btn.parentElement.classList.contains('open');
          document.querySelectorAll('.wh-dropdown.open').forEach(function(d){d.classList.remove('open')});
          if(!open) btn.parentElement.classList.add('open');
        });
      });
      document.addEventListener('click', function(){
        document.querySelectorAll('.wh-dropdown.open').forEach(function(d){d.classList.remove('open')});
      });
      function tick(){
        var el = document.getElementById('whClock');
        if(!el) return;
        var d = new Date();
        var days=['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
        var hh=String(d.getHours()).padStart(2,'0'), mm=String(d.getMinutes()).padStart(2,'0'), ss=String(d.getSeconds()).padStart(2,'0');
        el.textContent = days[d.getDay()]+', '+d.getDate()+'/'+(d.getMonth()+1)+'/'+d.getFullYear()+' '+hh+':'+mm+':'+ss;
      }
      tick(); setInterval(tick, 1000);
    })();
  </script>`;
}

// ---- Left sidebar: Shortcuts / System Info / Staff Online (WHMCS-style) ----
async function adminSidebar(admin) {
  const shortcuts = [
    { perm: 'manage_clients', href: '/admin/clients/new', label: 'Add New Client', ic: ICON.user(15) },
    { perm: 'manage_orders', href: '/admin/orders/new', label: 'Add New Order', ic: ICON.cart(15) },
    { perm: 'manage_orders', href: '/admin/services/generate-due', label: 'Generate Due Invoices', ic: ICON.receipt(15), post: true },
    { perm: 'manage_invoices', href: '/admin/invoices', label: 'View All Invoices', ic: ICON.file(15) },
  ].filter((s) => hasPerm(admin, s.perm));

  const shortcutsHtml = shortcuts.map((s) => s.post
    ? `<form method="post" action="${s.href}"><button type="submit" class="side-link"><span class="ic">${s.ic}</span>${esc(s.label)}</button></form>`
    : `<a class="side-link" href="${s.href}"><span class="ic">${s.ic}</span>${esc(s.label)}</a>`
  ).join('');

  const totalClients = (await get('SELECT COUNT(*) c FROM clients')).c;
  const totalAdmins = (await get("SELECT COUNT(*) c FROM admins WHERE status='Active'")).c;

  const staff = await all("SELECT name, username, last_login, status FROM admins ORDER BY (last_login IS NULL), last_login DESC LIMIT 6");
  const staffHtml = staff.map((s) => `<div class="staff-row">
      <span class="dot ${s.status === 'Active' ? 'on' : 'off'}"></span>
      <div><b>${esc(s.name)}</b><span class="muted" style="display:block;font-size:.72rem">${s.last_login ? 'Login ' + fmtDateTime(s.last_login) : 'Belum pernah login'}</span></div>
    </div>`).join('');

  return `<aside class="wh-sidebar">
    <div class="side-box">
      <div class="side-head">Shortcuts</div>
      <div class="side-body">${shortcutsHtml}</div>
    </div>
    <div class="side-box">
      <div class="side-head">System Information</div>
      <div class="side-body sys-info">
        <div>Sistem: <b>OmsetAI Billing</b></div>
        <div>Versi: <b>1.0.0</b></div>
        <div>Total Klien: <b>${totalClients}</b></div>
        <div>Admin Aktif: <b>${totalAdmins}</b></div>
      </div>
    </div>
    <div class="side-box">
      <div class="side-head">Staff Online</div>
      <div class="side-body">${staffHtml || '<span class="muted">Tidak ada data.</span>'}</div>
    </div>
  </aside>`;
}

async function adminLayout({ title, active, admin, crumb, body, session }) {
  const initials = (admin.name || 'A').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return `<!doctype html><html lang="id"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} · OmsetAI Billing</title>
    <link rel="stylesheet" href="/css/style.css">
  </head><body class="wh-body">
    <header class="wh-header">${await topNavbar(active, admin)}</header>
    <div class="wh-shell">
      ${await adminSidebar(admin)}
      <div class="admin-main">
        <header class="topbar">
          <div class="crumb">${crumb || ''}</div>
          <div class="tb-right">
            <div class="tb-user">
              <div class="avatar">${esc(initials)}</div>
              <div class="who"><b>${esc(admin.name)}</b><span>${esc(admin.roleName || 'Admin')}</span></div>
            </div>
          </div>
        </header>
        <main class="content">
          ${flash(session)}
          ${body}
        </main>
      </div>
    </div>
  </body></html>`;
}

// ---- Lightweight pure-SVG bar chart (no dependencies) ----
function trendChart(data, { width = 640, height = 200, valueFmt = rupiah } = {}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const padL = 10, padR = 10, padT = 16, padB = 28;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;
  const n = data.length;
  const barW = Math.max(4, chartW / n - 6);
  const bars = data.map((d, i) => {
    const x = padL + (i * chartW) / n + 3;
    const h = max > 0 ? (d.value / max) * chartH : 0;
    const y = padT + chartH - h;
    const showLabel = n <= 14 || i % Math.ceil(n / 10) === 0;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="var(--green)"><title>${esc(d.label)}: ${esc(valueFmt(d.value))}</title></rect>
      ${showLabel ? `<text x="${(x + barW / 2).toFixed(1)}" y="${height - 8}" font-size="9" fill="#667670" text-anchor="middle">${esc(d.shortLabel || d.label)}</text>` : ''}`;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
    <line x1="${padL}" y1="${padT + chartH}" x2="${width - padR}" y2="${padT + chartH}" stroke="#e4ebe7"/>
    ${bars}
  </svg>`;
}

// ---- Public / storefront layout ----
function publicLayout({ title, body, client }) {
  const right = client
    ? `<a href="/clientarea">Halo, ${esc(client.first_name)}</a><a href="/clientarea" class="btn btn-outline btn-sm">Client Area</a><a href="/logout" class="btn btn-sm">Keluar</a>`
    // === FLOW LOGIN BARU === "Masuk" langsung ke https://omset.ai/ (popup login
    // OmsetAI yang sebenarnya) — bukan /login lagi (form manual sudah dicabut).
    : `<a href="https://omset.ai/" target="_blank">Kembali ke OmsetAI</a><a href="https://omset.ai/" class="btn btn-outline btn-sm">Masuk</a><a href="/register" class="btn btn-sm">Daftar</a>`;
  return `<!doctype html><html lang="id"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} · OmsetAI Billing</title>
    <link rel="stylesheet" href="/css/style.css">
  </head><body>
    <nav class="public-nav"><div class="inner">
      <a href="/" class="brand">${BRAND_MARK} <span style="font-weight:500;color:#667670;font-size:.8rem;">Billing</span></a>
      <div class="links">${right}</div>
    </div></nav>
    ${body}
    <footer style="text-align:center;padding:2rem;color:#667670;font-size:.8rem;border-top:1px solid var(--line);background:#fff;">
      © ${new Date().getFullYear()} OmsetAI — PT Indotrading. Portal Billing &amp; Order.
    </footer>
  </body></html>`;
}

function pager(baseUrl, page, totalPages, extra = '') {
  if (totalPages <= 1) return '';
  let html = '<div style="display:flex;gap:.4rem;margin-top:1rem;justify-content:flex-end;">';
  for (let i = 1; i <= totalPages; i++) {
    const cls = i === page ? 'btn btn-sm' : 'btn btn-ghost btn-sm';
    html += `<a class="${cls}" href="${baseUrl}?page=${i}${extra}">${i}</a>`;
  }
  return html + '</div>';
}

module.exports = { esc, badge, flash, adminLayout, publicLayout, LOGO_SVG, BRAND_MARK, brandMark, ICON, rupiah, fmtDate, fmtDateTime, pager, trendChart };
