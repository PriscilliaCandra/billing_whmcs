# Handoff — Integrasi SahabatAI Billing ke ai.indotrading.com

Dokumen ini untuk tim yang akan **merge / deploy** aplikasi billing ini supaya terhubung
dengan domain **https://ai.indotrading.com/** (landing page SahabatAI). Untuk penjelasan
fitur & cara pakai sehari-hari, lihat [README.md](README.md).

## Apa isinya

Aplikasi billing bergaya WHMCS (storefront + checkout + client area + admin panel) untuk
jual paket SahabatAI (Starter/Growth/Professional/Enterprise + add-on Training User).
Ditulis sebagai **satu proses Node.js tunggal, tanpa dependency eksternal** — hanya modul
bawaan Node (`node:http`, `node:sqlite`, `node:crypto`). Tidak ada `npm install`, tidak ada
build step, database SQLite dibuat otomatis di `data/whmcs.db`.

Kenapa dibuat begini: supaya mudah di-review, di-deploy, dan dipindah-pindah tanpa
bergantung pada registry npm atau versi paket pihak ketiga.

## Requirement

- **Node.js 22.5+** (perlu `node:sqlite`, ditandai *experimental* oleh Node.js — jalan
  stabil di pengujian kami, tapi cek dulu di versi Node yang dipakai server produksi kalian).
  Jika platform target tidak mengizinkan modul experimental, opsi migrasi ada di bagian
  **Catatan Migrasi Database** di bawah.
- Tidak butuh database eksternal, tidak butuh reverse proxy khusus (tapi direkomendasikan
  ada satu di depan untuk TLS — lihat bagian Integrasi).

## Menjalankan

```bash
node server.js
```

Default port **3400** (`PORT=8080 node server.js` untuk ganti). Server bind ke `0.0.0.0`
sehingga otomatis bisa diakses dari luar `localhost` begitu firewall/port dibuka.

## Environment Variables

| Variable | Default | Kegunaan |
|---|---|---|
| `PORT` | `3400` | Port HTTP yang dipakai server |
| `WHMCS_DB` | `data/whmcs.db` | Lokasi file database SQLite |
| `SHOW_DEMO_HINTS` | *(off)* | Set `true` **hanya di lingkungan dev/demo internal** untuk menampilkan kredensial demo di halaman login. **Biarkan tidak di-set (default: tersembunyi) di production/publik.** |
| `TRUST_PROXY` | *(off)* | Set `true` jika app dijalankan di belakang reverse proxy yang terminasi TLS (Nginx/Cloudflare/dll) dan meneruskan header `X-Forwarded-Proto: https` — ini membuat cookie sesi otomatis diberi flag `Secure`. |

## Integrasi ke domain ai.indotrading.com

Ada dua pola umum. **Subdomain lebih direkomendasikan** karena tidak perlu ubah kode apa pun.

### Opsi A — Subdomain (rekomendasi): `billing.ai.indotrading.com`

1. Jalankan `node server.js` di server sebagai service (lihat **Menjaga Proses Tetap Hidup**
   di bawah), listen di port internal (mis. 3400).
2. Arahkan DNS `billing.ai.indotrading.com` (atau nama subdomain lain) ke server tersebut.
3. Pasang reverse proxy (Nginx contoh di bawah) yang terminasi HTTPS dan proxy ke
   `http://127.0.0.1:3400`.
4. Set `TRUST_PROXY=true` saat menjalankan `server.js` supaya cookie sesi otomatis `Secure`.
5. Di landing page `ai.indotrading.com`, ubah tombol **"Coba Gratis"** / **"Masuk"** / link
   Harga agar mengarah ke `https://billing.ai.indotrading.com/` (storefront) — lihat bagian
   **Titik Sambung dari Landing Page** di bawah untuk detail per tombol.

Contoh konfigurasi Nginx:

```nginx
server {
    listen 443 ssl http2;
    server_name billing.ai.indotrading.com;

    ssl_certificate     /etc/letsencrypt/live/billing.ai.indotrading.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/billing.ai.indotrading.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3400;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

### Opsi B — Subpath: `ai.indotrading.com/billing`

**Belum didukung out-of-the-box.** Semua route di app ini pakai path absolut
(`/admin`, `/clientarea`, `/login`, dst — lihat `routes/admin.js` & `routes/client.js`),
jadi proxy `location /billing/ { proxy_pass http://127.0.0.1:3400/; }` saja akan
menyebabkan link internal & redirect balik ke `/admin` bukan `/billing/admin`.
Kalau opsi ini yang dipilih, perlu tambahan kerja: refactor router + semua string path
untuk pakai `BASE_PATH` env var sebagai prefix. Beri tahu kami kalau ini yang dipilih —
ini pekerjaan terpisah, bukan sekadar config, dan sebaiknya di-scope dulu sebelum dikerjakan.

### Titik Sambung dari Landing Page

Landing page `ai.indotrading.com` (lihat referensi di `material project sahabat ai/Sahabat AI - GTM Kit/01_Landing_Page/`)
punya beberapa CTA yang perlu diarahkan ke billing:

| Elemen di landing page | Arahkan ke |
|---|---|
| Tombol "Coba Gratis" / "Mulai Sekarang" (paket Starter–Professional) | `https://billing.ai.indotrading.com/` (storefront pricing) |
| Link section `#harga` / "Pilih Growth" dsb. | `https://billing.ai.indotrading.com/` |
| Tombol "Hubungi Sales" (Enterprise) | tetap ke form/WA sales seperti sekarang — Enterprise di billing app statusnya "mulai dari, harga custom", bukan checkout otomatis |
| Login existing user | `https://billing.ai.indotrading.com/login` (client area) |

Billing app ini **mewajibkan user sudah punya akun SahabatAI dulu** sebelum checkout
(sesuai requirement awal) — form register di `/register` punya checkbox konfirmasi untuk itu.

## Menjaga Proses Tetap Hidup (production)

`node server.js` berjalan sebagai proses tunggal — di production jangan dijalankan manual
di terminal. Pakai salah satu:

- **systemd** (Linux) — buat unit file yang menjalankan `node server.js` dengan
  `Restart=always`, `Environment=PORT=3400`, `Environment=TRUST_PROXY=true`.
- **pm2** — `pm2 start server.js --name sahabatai-billing` (perlu `npm install -g pm2`
  di server target; catatan: `npm` di mesin development kami sempat rusak, jadi verifikasi
  dulu `npm` sehat di server tujuan sebelum bergantung padanya).

## Checklist Keamanan Sebelum Go-Live

- [ ] **Ganti semua password demo** — akun admin `musa`/`handy` dan klien `demo@client.com`
      dibuat untuk development. Buat akun admin baru lewat **Admin → Akun Admin**, lalu
      nonaktifkan/hapus akun demo (halaman **Admin → Akun Admin**, tombol Hapus — sistem
      akan menolak kalau itu admin aktif terakhir, jadi buat akun pengganti dulu).
- [ ] **Jangan set `SHOW_DEMO_HINTS=true`** di environment production/publik (default sudah
      aman/tersembunyi — cukup pastikan tidak ada yang menyalakannya).
- [ ] **Set `TRUST_PROXY=true`** kalau memang di belakang reverse proxy HTTPS, supaya cookie
      sesi dapat flag `Secure`.
- [ ] **Backup rutin `data/whmcs.db`** — ini satu file SQLite, gampang di-backup (`cp`/rsync
      berkala), tapi juga gampang hilang kalau tidak dibackup sama sekali.
- [ ] Review isi `data/whmcs.db` sebelum go-live — kalau ingin mulai dari kosong (tanpa data
      dummy demo), jalankan `node src/schema.js --reset` di server target SEBELUM
      membiarkan user asli mendaftar.

## Catatan Migrasi Database (opsional, jika `node:sqlite` bermasalah di server target)

Aplikasi ini mengakses database lewat satu file (`src/db.js`) yang membungkus
`node:sqlite`. Kalau server produksi kalian pakai versi Node yang lebih lama atau
kebijakan yang melarang modul experimental, cara migrasi paling ringan: ganti isi
`src/db.js` untuk pakai library SQLite pihak ketiga (mis. `better-sqlite3`) dengan API
yang sama (`get`/`all`/`run`) — kode lain di aplikasi (routes, services) tidak perlu
diubah karena semua akses DB sudah lewat helper ini.

## Struktur Proyek

Lihat bagian **Struktur Proyek** di [README.md](README.md).

## Referensi yang Dipakai Saat Membangun Ini

- Tampilan admin: referensi screenshot WHMCS internal (`billing.indotrading.com`) — dilihat
  saja, tidak pernah diubah.
- Data produk & harga: `material project sahabat ai/Sahabat AI - GTM Kit/02_Pricing_Model/Sahabat_AI_Pricing_Model.xlsx`
  dan landing page di folder yang sama.
- Tema warna: mengikuti hijau SahabatAI dari `ai.indotrading.com`.
