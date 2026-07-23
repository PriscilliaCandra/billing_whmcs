'use strict';
// Authentication + account loading for admins and clients.
// (PostgreSQL / pg — async: get mengembalikan Promise, wajib di-await.)
const { get } = require('../db');
const { verifyPassword } = require('../lib/crypto');

async function hydrateAdmin(admin) {
  if (!admin) return null;
  const role = admin.role_id ? await get('SELECT * FROM roles WHERE id = ?', admin.role_id) : null;
  let permissions = [];
  try { permissions = role ? JSON.parse(role.permissions) : []; } catch { permissions = []; }
  return {
    ...admin,
    roleName: role ? role.name : 'No Role',
    permissions,
    isFull: role && role.name === 'Full Administrator',
  };
}

async function getAdminById(id) {
  return hydrateAdmin(await get('SELECT * FROM admins WHERE id = ?', id));
}

async function authenticateAdmin(username, password) {
  const admin = await get('SELECT * FROM admins WHERE username = ? OR email = ?', username, username);
  if (!admin || admin.status !== 'Active') return null;
  if (!verifyPassword(password, admin.password)) return null;
  return hydrateAdmin(admin);
}

async function getClientById(id) {
  return get('SELECT * FROM clients WHERE id = ?', id);
}

async function authenticateClient(email, password) {
  const client = await get('SELECT * FROM clients WHERE email = ?', email);
  if (!client) return null;
  if (!verifyPassword(password, client.password)) return null;
  return client;
}

// Permission check for an admin (Full Administrator implicitly has all).
// Murni sinkron — tidak menyentuh DB.
function can(admin, perm) {
  if (!admin) return false;
  if (admin.isFull) return true;
  if (!perm) return true;
  return (admin.permissions || []).includes(perm);
}

module.exports = { getAdminById, authenticateAdmin, getClientById, authenticateClient, can, hydrateAdmin };
