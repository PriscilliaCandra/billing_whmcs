'use strict';
// Thin wrapper around a MySQL connection pool (mysql2/promise).
//
// MIGRASI SQLite -> MySQL: dulu file ini memakai node:sqlite (DatabaseSync) yang
// SINKRON. Sekarang memakai mysql2 yang ASINKRON, jadi get/run/all mengembalikan
// Promise dan HARUS di-`await` oleh pemanggil.
//
// Konfigurasi dibaca dari environment (TIDAK di-hardcode). Default-nya cocok
// dengan MySQL bawaan Laragon (root, tanpa password) agar jalan out-of-box di
// lokal. Database billing SENGAJA TERPISAH dari database `sahabatai` — jangan
// arahkan BILLING_DB_NAME ke `sahabatai`.
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.BILLING_DB_HOST || 'localhost',
  port: Number(process.env.BILLING_DB_PORT) || 3306,
  user: process.env.BILLING_DB_USER || 'root',
  password: process.env.BILLING_DB_PASSWORD || '',
  database: process.env.BILLING_DB_NAME || 'billing',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  // multipleStatements: dibutuhkan schema.js (satu exec berisi banyak CREATE TABLE).
  multipleStatements: true,
  // Kembalikan DECIMAL/BIGINT sebagai angka JS biasa (kolom kita INT, aman).
  supportBigNumbers: true,
});

// Small helpers so callers don't repeat pool.query() everywhere.
// CATATAN: memakai pool.query() (bukan pool.execute()) supaya `LIMIT ? OFFSET ?`
// dengan parameter tidak error — ini gotcha khas prepared-statement mysql2.
//
// - run(sql, ...params)  -> { insertId, affectedRows } (untuk INSERT/UPDATE/DELETE)
// - get(sql, ...params)  -> baris pertama (objek) atau undefined
// - all(sql, ...params)  -> array baris
async function run(sql, ...params) {
  const [result] = await pool.query(sql, params);
  return result; // punya .insertId dan .affectedRows
}
async function get(sql, ...params) {
  const [rows] = await pool.query(sql, params);
  return rows[0];
}
async function all(sql, ...params) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// exec(): jalankan SQL mentah (bisa multi-statement) tanpa parameter.
// Pengganti db.exec() milik node:sqlite yang dipakai schema.js (CREATE/DROP TABLE).
async function exec(sql) {
  await pool.query(sql);
}

// `db` diekspor untuk kompatibilitas nama lama; kini menunjuk ke pool + exec().
const db = { pool, exec };

module.exports = { db, pool, run, get, all, exec };
