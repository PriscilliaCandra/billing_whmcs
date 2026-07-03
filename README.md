# SahabatAI Billing (WHMCS-style)

Dashboard admin + portal billing untuk mengatur pembelian produk **SahabatAI** (https://ai.indotrading.com/),
dibuat mirip WHMCS. Tema mengikuti warna hijau SahabatAI.

> Mau merge/deploy ini supaya nyambung ke domain **ai.indotrading.com**? Lihat **[HANDOFF.md](HANDOFF.md)**
> untuk panduan integrasi (subdomain vs subpath, reverse proxy, checklist keamanan sebelum go-live).

Dibangun dengan Node.js (`node:http`, `node:crypto`) + **MySQL** via
[`mysql2`](https://www.npmjs.com/package/mysql2). Database berada di server MySQL
yang **sama** dengan SahabatAI, tetapi pada **database terpisah** bernama `billing`
(tidak bercampur dengan database `sahabatai`).

## Menjalankan

Butuh **Node.js versi 18 ke atas** dan **MySQL** (mis. Laragon di lokal).

1. **Install dependency** (sekali):
   ```bash
   npm install
   ```
2. **Buat database** `billing` (sekali) — di server MySQL yang sama dengan SahabatAI:
   ```sql
   CREATE DATABASE billing CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
   ```
3. **Konfigurasi koneksi** — salin `.env.example` menjadi `.env` lalu sesuaikan bila
   kredensial MySQL Anda berbeda dari default Laragon (`root` tanpa password):
   ```bash
   cp .env.example .env
   ```
   > Catatan: server tidak memuat `.env` secara otomatis (tanpa `dotenv`). Nilai dibaca
   > dari environment. Di lokal, default in-code sudah cocok Laragon. Untuk produksi,
   > set variabel `BILLING_DB_*` di environment proses (systemd/pm2/panel hosting).
4. **Isi tabel + data demo** (sekali):
   ```bash
   npm run seed
   ```
5. **Jalankan**:
   ```bash
   npm start
   ```
   Atau klik dua kali **`start.bat`** (Windows). Skema tabel juga otomatis dipastikan
   ada saat server pertama menyala (dan di-seed bila database masih kosong).

### Reset data demo
```bash
npm run reset
```

## Akses (development lokal)

| Halaman | Lokal (PC ini) | LAN (WiFi yang sama) |
|---|---|---|
| **Storefront / Billing** | http://localhost:3400/ | http://192.168.6.17:3400/ |
| **Admin Panel** | http://localhost:3400/admin/login | http://192.168.6.17:3400/admin/login |
| **Client Area** | http://localhost:3400/clientarea | http://192.168.6.17:3400/clientarea |

- **LAN**: perangkat lain harus konek ke WiFi yang sama (gateway `192.168.6.1`). Firewall Windows sudah
  diizinkan untuk port 3400 (rule "SahabatAI Billing (3400)").
- Butuh URL publik sementara untuk demo cepat (bukan untuk domain resmi)? Jalankan
  `tools\start-tunnel.bat` — ini membuat tunnel Cloudflare gratis tanpa akun, URL berbeda
  setiap kali dijalankan, dan PC ini harus tetap menyala selama tunnel aktif.
- **Untuk akses lewat domain `ai.indotrading.com` yang sebenarnya (permanen)**, ini bukan
  lagi urusan tunnel — lihat **[HANDOFF.md](HANDOFF.md)** untuk cara integrasinya.

## Akun Demo

| Peran | Login | Password |
|-------|-------|----------|
| Admin (Full Administrator) | `musa` | `Tobethebest123#` |
| Admin (Sales Manager)      | `handy` | `handy123` |
| Klien                      | `demo@client.com` | `demo123` |

## Produk & Harga

Paket: **Starter, Growth, Professional, Enterprise** — masing-masing punya harga untuk
periode **3 Bulan, 6 Bulan, 1 Tahun**. Add-on: **Training User (One to One)** (one-time / sesi).

Harga dasar & fitur diambil dari `Sahabat_AI_Pricing_Model.xlsx` dan landing page resmi
di `material project sahabat ai/Sahabat AI - GTM Kit/`. Harga bulanan dikalikan jumlah bulan
untuk periode 3/6 bulan; periode 1 tahun dapat diskon 2 bulan (~17%, "bayar 10 dapat 12")
sesuai model & landing page.

| Paket | /bulan | 3 Bulan | 6 Bulan | 1 Tahun | Setup Fee |
|---|---|---|---|---|---|
| Starter | Rp 299.000 | Rp 897.000 | Rp 1.794.000 | Rp 2.990.000 | Rp 0 |
| Growth | Rp 749.000 | Rp 2.247.000 | Rp 4.494.000 | Rp 7.490.000 | Rp 500.000 |
| Professional | Rp 1.990.000 | Rp 5.970.000 | Rp 11.940.000 | Rp 19.900.000 | Rp 1.500.000 |
| Enterprise | Rp 5.000.000 (mulai dari, custom) | Rp 15.000.000 | Rp 30.000.000 | Rp 50.000.000 | Rp 2.500.000 |

- **Setup fee** dikenakan **sekali** saat pembelian pertama sebuah paket.
- **Renewal / perpanjangan** dan pembelian ulang paket yang sama → **tanpa setup fee**.

Harga & fitur bisa diubah dari **Admin → Produk & Harga**.

## Fitur Admin (mirip WHMCS)

Tampilan admin memakai chrome dua-tingkat ala WHMCS: strip alert tipis (order pending,
invoice belum dibayar, layanan segera jatuh tempo) + jam berjalan, navbar dengan menu
dropdown (Clients/Orders/Billing/Produk/Setup), dan sidebar kiri berisi **Shortcuts**,
**System Information**, **Staff Online** — semua dengan data live dari database.

- **Dashboard** — stat card berwarna (Pending Orders, Invoice Belum Dibayar, Layanan
  Jatuh Tempo, Klien Baru), grafik pendapatan 14 hari, ringkasan aktivitas bulanan,
  widget billing, dan daftar layanan yang segera jatuh tempo.
- **Klien** — daftar, cari, tambah klien baru, edit profil, reset password, hapus.
- **Order** — terima (aktifkan layanan + tandai invoice lunas) / batalkan / **Add New Order**
  (staff bisa buat order manual atas nama klien, mis. order via telepon/WA).
- **Invoice** — lihat, tandai lunas, batalkan.
- **Layanan Aktif** — ubah status (Active/Suspended/Terminated/dll), shortcut
  **Generate Due Invoices** (buat invoice perpanjangan otomatis untuk layanan yang
  jatuh tempo ≤ 7 hari, tanpa setup fee).
- **Produk & Harga** — edit harga per periode + setup fee.
- **Akun Admin** — tambah/edit/hapus anggota tim admin; setiap admin juga punya
  **My Account** untuk edit profil/password sendiri.
- **Role & Hak Akses** — buat role & atur izin per modul (mirip WHMCS Administrator Roles).
  Role `Full Administrator` (mis. akun `musa`) punya semua izin.

## Alur Billing (mirip cart.php)

1. User **wajib punya akun SahabatAI dulu** (daftar di ai.indotrading.com).
2. Daftar / masuk di portal billing (`/register`, `/login`).
3. Pilih paket di storefront → **Checkout** (`/order`): pilih periode, tambah add-on training.
4. Order + Invoice dibuat → bayar di **Client Area** (simulasi pembayaran).
5. Setelah lunas, layanan aktif. Bisa **perpanjang** dari Client Area (tanpa setup fee).

## Struktur Proyek

```
server.js              Entry point (HTTP server + session + router)
routes/
  admin.js             Semua route admin panel
  client.js            Storefront + client area
src/
  db.js                Koneksi MySQL (pool mysql2/promise) + helper get/run/all
  schema.js            Skema tabel (MySQL) + seed data
  services/
    orders.js          Logika order, invoice, setup fee, renewal
    auth.js            Autentikasi admin & klien, cek permission
  lib/                 router, http, crypto, format helpers
  views/
    ui.js              Layout admin + storefront + komponen
    adminAuth.js       Halaman login admin
public/css/style.css   Tema hijau SahabatAI
.env.example           Contoh konfigurasi (koneksi MySQL, PORT, TRUST_PROXY)
tools/cloudflared.exe  Binary tunnel untuk akses publik (lihat bagian Akses)
tools/start-tunnel.bat Shortcut untuk membuka tunnel publik baru
```

## Catatan

- Ganti port: `PORT=8080 node server.js`.
- Ini portal billing mandiri; integrasi login nyata ke ai.indotrading.com belum dihubungkan —
  klien memakai email SahabatAI mereka sebagai identitas di portal ini.
- Kredensial demo (`musa`/`demo@client.com`) **tersembunyi secara default** di halaman login.
  Untuk memunculkannya saat demo/dev internal saja, jalankan dengan `SHOW_DEMO_HINTS=true`
  (lihat [HANDOFF.md](HANDOFF.md) untuk daftar env var lengkap).
- Untuk deploy ke domain publik permanen (`ai.indotrading.com`), lihat **[HANDOFF.md](HANDOFF.md)**.
