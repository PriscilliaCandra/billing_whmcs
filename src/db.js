'use strict';
// Thin wrapper around a PostgreSQL connection pool (node-postgres / `pg`).
//
// MIGRASI MySQL -> PostgreSQL: dulu file ini memakai mysql2/promise dengan
// placeholder `?`. Semua kode pemanggil (routes/services/schema) TETAP menulis
// SQL dengan placeholder `?` — toPgParams() di bawah menerjemahkannya ke `$1,$2,...`
// secara otomatis, jadi tak ada satu pun call-site yang perlu diubah.
//
// Konfigurasi dibaca dari environment (TIDAK di-hardcode). Database billing
// SENGAJA TERPISAH dari database `sahabatai` — jangan arahkan PG_DATABASE ke situ.
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT) || 5432,
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DATABASE || 'billing_whmcs',
  ssl: process.env.PG_SSL === 'require' ? { rejectUnauthorized: false } : false,
});

// `?` -> `$1, $2, ...` posisional (kontrak placeholder lama tetap dipakai semua caller).
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// INSERT tanpa RETURNING tak bisa memberi id balik (beda dari mysql2 insertId
// otomatis). Semua tabel PUNYA kolom `id` KECUALI `sessions` (PK-nya `sid`) — jadi
// auto-tambahkan RETURNING id ke semua INSERT INTO ... KECUALI ke tabel sessions.
function withReturningId(sql) {
  if (/^\s*INSERT\s+INTO\s+sessions\b/i.test(sql)) return sql;
  if (/RETURNING\b/i.test(sql)) return sql;
  if (!/^\s*INSERT\s+INTO\b/i.test(sql)) return sql;
  return sql.replace(/;\s*$/, '') + ' RETURNING id';
}

// - run(sql, ...params)  -> { insertId, affectedRows } (untuk INSERT/UPDATE/DELETE)
// - get(sql, ...params)  -> baris pertama (objek) atau undefined
// - all(sql, ...params)  -> array baris
async function run(sql, ...params) {
  const text = toPgSql(withReturningId(sql));
  const res = await pool.query(text, params);
  return { insertId: res.rows[0] ? res.rows[0].id : undefined, affectedRows: res.rowCount };
}
async function get(sql, ...params) {
  const res = await pool.query(toPgSql(sql), params);
  return res.rows[0];
}
async function all(sql, ...params) {
  const res = await pool.query(toPgSql(sql), params);
  return res.rows;
}

// exec(): jalankan SQL mentah (bisa multi-statement, TANPA parameter — dipakai
// schema.js utk beberapa CREATE TABLE sekaligus). node-postgres mendukung ini
// selama query() dipanggil tanpa array parameter (mode "simple query").
async function exec(sql) {
  await pool.query(sql);
}

// `db` diekspor untuk kompatibilitas nama lama; kini menunjuk ke pool + exec().
const db = { pool, exec };

module.exports = { db, pool, run, get, all, exec };
