'use strict';
// Database schema + seed data. (PostgreSQL / node-postgres — async.)
//
// === FIX GAP KONFIGURASI === WAJIB dimuat SEBELUM `require('./db')` di baris
// berikutnya — db.js membuat Pool langsung saat modulnya di-load pertama kali
// (baca process.env SAAT ITU JUGA), jadi kalau .env dimuat SETELAH baris itu
// (mis. dulu ditaruh di blok `require.main === module` di bawah), Pool sudah
// terlanjur pakai default salah (localhost) — gagal konek senyap ke server asli.
// Aman dipanggil dobel (server.js juga memanggilnya): loadEnvFile() tak pernah
// menimpa key yang sudah ada di process.env.
require('./lib/loadEnv').loadEnvFile();
const { run, get, all, exec } = require('./db');
const { hashPassword } = require('./lib/crypto');
const { todayISO, nowISO } = require('./lib/format');

const ALL_PERMISSIONS = [
  'manage_clients',
  'manage_orders',
  'manage_invoices',
  'manage_products',
  'manage_admins',
  'manage_roles',
  'view_reports',
];

async function ensureSchema() {
  // Catatan konversi PostgreSQL:
  //  - INT AUTO_INCREMENT PRIMARY KEY -> SERIAL PRIMARY KEY
  //  - Kolom tanggal SENGAJA tetap VARCHAR (bukan DATE/TIMESTAMP) supaya nilai
  //    string ISO ("2026-07-02" / "...T...Z") & perbandingan string tetap identik
  //    dengan perilaku lama — query yang butuh date-arithmetic (CURDATE()+INTERVAL
  //    dulu) cast eksplisit ke ::date di pemanggil (lihat routes/admin.js, ui.js).
  //  - sessions.expires = Date.now()+TTL (~1.7e12) MELEBIHI jangkauan INT -> BIGINT.
  //  - Kolom teks bebas (notes/description/features/address/data) -> TEXT.
  //  - PostgreSQL tak punya ENGINE=/CHARSET= (default sudah UTF-8).
  await exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      permissions TEXT,
      created_at VARCHAR(30) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      username VARCHAR(100) UNIQUE NOT NULL,
      email VARCHAR(191),
      password VARCHAR(255) NOT NULL,
      role_id INT,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      last_login VARCHAR(30),
      created_at VARCHAR(30) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100),
      email VARCHAR(191) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      company VARCHAR(191),
      phone VARCHAR(40),
      address TEXT,
      city VARCHAR(100),
      country VARCHAR(100) DEFAULT 'Indonesia',
      sahabatai_account VARCHAR(191),
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      notes TEXT,
      created_at VARCHAR(30) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name VARCHAR(150) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'package',
      tagline VARCHAR(255),
      description TEXT,
      features TEXT,
      setup_fee INT NOT NULL DEFAULT 0,
      price_3 INT NOT NULL DEFAULT 0,
      price_6 INT NOT NULL DEFAULT 0,
      price_12 INT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Active',
      sort_order INT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_num VARCHAR(40) UNIQUE NOT NULL,
      client_id INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      amount INT NOT NULL DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'Bank Transfer',
      notes TEXT,
      created_at VARCHAR(30) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      client_id INT NOT NULL,
      product_id INT NOT NULL,
      order_id INT,
      name VARCHAR(191) NOT NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'package',
      billing_cycle VARCHAR(30) NOT NULL,
      term_months INT NOT NULL DEFAULT 0,
      recurring_amount INT NOT NULL DEFAULT 0,
      setup_fee INT NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'Pending',
      reg_date VARCHAR(30),
      next_due_date VARCHAR(30),
      created_at VARCHAR(30) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      invoice_num VARCHAR(40) UNIQUE NOT NULL,
      client_id INT NOT NULL,
      order_id INT,
      date_created VARCHAR(30) NOT NULL,
      date_due VARCHAR(30) NOT NULL,
      date_paid VARCHAR(30),
      status VARCHAR(20) NOT NULL DEFAULT 'Unpaid',
      subtotal INT NOT NULL DEFAULT 0,
      total INT NOT NULL DEFAULT 0,
      payment_method VARCHAR(50) DEFAULT 'Bank Transfer',
      notes VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id SERIAL PRIMARY KEY,
      invoice_id INT NOT NULL,
      type VARCHAR(30) NOT NULL DEFAULT 'line',
      description VARCHAR(500) NOT NULL,
      amount INT NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR(64) PRIMARY KEY,
      data TEXT NOT NULL,
      expires BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      actor VARCHAR(150),
      action VARCHAR(255),
      created_at VARCHAR(30) NOT NULL
    );
  `);
}

async function seed() {
  await ensureSchema();
  const now = nowISO();

  // ---- Roles ----
  if (!await get('SELECT id FROM roles LIMIT 1')) {
    await run(
      'INSERT INTO roles (name, permissions, created_at) VALUES (?,?,?)',
      'Full Administrator',
      JSON.stringify(ALL_PERMISSIONS),
      now
    );
    await run(
      'INSERT INTO roles (name, permissions, created_at) VALUES (?,?,?)',
      'Sales Manager',
      JSON.stringify(['manage_clients', 'manage_orders', 'manage_invoices', 'view_reports']),
      now
    );
    await run(
      'INSERT INTO roles (name, permissions, created_at) VALUES (?,?,?)',
      'Support Staff',
      JSON.stringify(['manage_clients']),
      now
    );
  }

  const fullAdminRole = await get("SELECT id FROM roles WHERE name = 'Full Administrator'");

  // ---- Admin accounts ----
  if (!await get('SELECT id FROM admins LIMIT 1')) {
    await run(
      'INSERT INTO admins (name, username, email, password, role_id, status, created_at) VALUES (?,?,?,?,?,?,?)',
      'Musa Administrator',
      'musa',
      'musa@sahabatai.id',
      hashPassword('Tobethebest123#'),
      fullAdminRole.id,
      'Active',
      now
    );
    const salesRole = await get("SELECT id FROM roles WHERE name = 'Sales Manager'");
    await run(
      'INSERT INTO admins (name, username, email, password, role_id, status, created_at) VALUES (?,?,?,?,?,?,?)',
      'Handy Sales',
      'handy',
      'handy@indotrading.com',
      hashPassword('handy123'),
      salesRole.id,
      'Active',
      now
    );
  }

  // ---- Products ----
  if (!await get('SELECT id FROM products LIMIT 1')) {
    // Harga dasar bulanan & fitur diambil dari Sahabat_AI_Pricing_Model.xlsx (sheet "Asumsi")
    // dan sahabatai-landing.html (GTM Kit). 3/6 bulan = bulanan x term (tanpa diskon).
    // 12 bulan = bulanan x10 (diskon 2 bulan / ~17%, sesuai "bayar 10 dapat 12" di model & landing page).
    const packages = [
      {
        name: 'Starter', slug: 'starter', tagline: 'Untuk UMKM yang mulai otomatisasi WhatsApp',
        setup: 0, p3: 897000, p6: 1794000, p12: 2990000, sort: 1,
        features: '2 user admin|150 lead / bln|1.000 broadcast / bln|AI auto-reply katalog|Pipeline + follow-up',
      },
      {
        name: 'Growth', slug: 'growth', tagline: 'Untuk bisnis berkembang dengan tim sales',
        setup: 500000, p3: 2247000, p6: 4494000, p12: 7490000, sort: 2,
        features: '5 user admin|500 lead / bln|5.000 broadcast / bln|Semua fitur Starter|Segmentasi & campaign',
      },
      {
        name: 'Professional', slug: 'professional', tagline: 'Untuk tim besar & volume tinggi',
        setup: 1500000, p3: 5970000, p6: 11940000, p12: 19900000, sort: 3,
        features: '15 user admin|2.000 lead / bln|20.000 broadcast / bln|Analytics lanjutan|Prioritas support',
      },
      {
        name: 'Enterprise', slug: 'enterprise', tagline: 'Untuk distributor & korporasi (mulai dari, harga custom)',
        setup: 2500000, p3: 15000000, p6: 30000000, p12: 50000000, sort: 4,
        features: 'User unlimited|Integrasi ERP & API|Multi-divisi / brand|SLA & dedicated CSM|Custom workflow & onboarding',
      },
    ];
    for (const p of packages) {
      await run(
        `INSERT INTO products (name, slug, type, tagline, features, setup_fee, price_3, price_6, price_12, status, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        p.name, p.slug, 'package', p.tagline, p.features, p.setup, p.p3, p.p6, p.p12, 'Active', p.sort
      );
    }
    // Add-on: Training User (one to one) — one-time price stored in price_3, no setup fee.
    await run(
      `INSERT INTO products (name, slug, type, tagline, features, setup_fee, price_3, price_6, price_12, status, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      'Training User (One to One)', 'training-user', 'addon',
      'Sesi pelatihan privat 1-on-1 untuk user Anda',
      'Sesi 1-on-1 dengan trainer|Durasi 2 jam per user|Materi & rekaman disediakan',
      0, 1500000, 0, 0, 'Active', 10
    );
  }

  // ---- Sample clients ----
  if (!await get('SELECT id FROM clients LIMIT 1')) {
    const clients = [
      {
        fn: 'Demo', ln: 'Client', email: 'demo@client.com', pass: 'demo123',
        company: 'PT Demo Nusantara', phone: '+62 812 0000 0001', city: 'Jakarta',
        sahabat: 'demo@client.com',
      },
      {
        fn: 'Budi', ln: 'Santoso', email: 'budi@tokomaju.co.id', pass: 'budi123',
        company: 'Toko Maju Jaya', phone: '+62 813 1111 2222', city: 'Surabaya',
        sahabat: 'budi@tokomaju.co.id',
      },
      {
        fn: 'Siti', ln: 'Rahayu', email: 'siti@bunda-store.com', pass: 'siti123',
        company: 'Bunda Store', phone: '+62 811 3333 4444', city: 'Bandung',
        sahabat: 'siti@bunda-store.com',
      },
    ];
    for (const c of clients) {
      await run(
        `INSERT INTO clients (first_name, last_name, email, password, company, phone, city, country, sahabatai_account, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        c.fn, c.ln, c.email, hashPassword(c.pass), c.company, c.phone, c.city, 'Indonesia', c.sahabat, 'Active', now
      );
    }

    // Give sample clients some order history (uses shared order logic).
    const { createOrder, activateOrder } = require('./services/orders');
    const growth = await get("SELECT id FROM products WHERE slug = 'growth'");
    const professional = await get("SELECT id FROM products WHERE slug = 'professional'");
    const starter = await get("SELECT id FROM products WHERE slug = 'starter'");
    const training = await get("SELECT id FROM products WHERE slug = 'training-user'");
    const budi = await get("SELECT id FROM clients WHERE email = 'budi@tokomaju.co.id'");
    const siti = await get("SELECT id FROM clients WHERE email = 'siti@bunda-store.com'");

    // Budi: Professional 1 year + 2 training sessions, paid & active.
    const o1 = await createOrder(budi.id, { packageId: professional.id, term: 12, addons: [{ id: training.id, qty: 2 }] });
    await activateOrder(o1.order.id);
    // Siti: Growth 6 months, still pending payment.
    await createOrder(siti.id, { packageId: growth.id, term: 6, addons: [{ id: training.id, qty: 1 }] });
    // Siti also has a paid Starter from before.
    const o3 = await createOrder(siti.id, { packageId: starter.id, term: 3, addons: [] });
    await activateOrder(o3.order.id);
  }

  console.log('Seed complete.');
}

async function reset() {
  for (const t of ['invoice_items', 'invoices', 'services', 'orders', 'products', 'clients', 'admins', 'roles', 'sessions', 'activity_log']) {
    await exec(`DROP TABLE IF EXISTS ${t};`);
  }
  await seed();
  console.log('Database reset.');
}

module.exports = { ensureSchema, seed, reset, ALL_PERMISSIONS };

if (require.main === module) {
  const arg = process.argv[2];
  const task = arg === '--reset' ? reset : arg === '--seed' ? seed : ensureSchema;
  // Jalankan lalu tutup pool agar proses keluar bersih (pg menahan event loop).
  const { pool } = require('./db');
  task()
    .then(() => pool.end())
    .catch((err) => { console.error('Gagal:', err.message); pool.end().finally(() => process.exit(1)); });
}
