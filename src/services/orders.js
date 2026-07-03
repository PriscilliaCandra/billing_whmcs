'use strict';
// Core billing logic shared by the storefront, client area, and admin.
// (MySQL / mysql2 — async: get/run/all mengembalikan Promise, wajib di-await.)
const { db, run, get, all } = require('../db');
const { todayISO, nowISO, addMonthsISO } = require('../lib/format');

const TERM_LABELS = { 3: '3 Bulan', 6: '6 Bulan', 12: '1 Tahun' };

function termPrice(product, term) {
  if (Number(term) === 3) return product.price_3;
  if (Number(term) === 6) return product.price_6;
  return product.price_12;
}

async function nextNumber(table, column, prefix) {
  const row = await get(`SELECT COUNT(*) AS c FROM ${table}`);
  const seq = (row ? row.c : 0) + 1001;
  return `${prefix}${seq}`;
}

// Setup fee applies only the FIRST time a client buys a given package.
// Any prior non-cancelled service for that product means it's a renewal/upgrade → no setup fee.
async function isFirstPurchase(clientId, productId) {
  const existing = await get(
    `SELECT id FROM services WHERE client_id = ? AND product_id = ?
       AND status NOT IN ('Cancelled') LIMIT 1`,
    clientId,
    productId
  );
  return !existing;
}

/**
 * Create an order for a client.
 * cart = { packageId, term (3|6|12), addons: [{ id, qty }] }
 * Creates: order (Pending) + service rows (Pending) + a single Unpaid invoice.
 */
async function createOrder(clientId, cart) {
  const now = nowISO();
  const today = todayISO();
  const pkg = await get('SELECT * FROM products WHERE id = ?', cart.packageId);
  if (!pkg) throw new Error('Package not found');
  const term = Number(cart.term) || 12;

  const firstPurchase = await isFirstPurchase(clientId, pkg.id);
  const recurring = termPrice(pkg, term);
  const setup = firstPurchase ? pkg.setup_fee : 0;

  const orderNum = await nextNumber('orders', 'order_num', 'ORD-');
  const orderRes = await run(
    'INSERT INTO orders (order_num, client_id, status, amount, payment_method, created_at) VALUES (?,?,?,?,?,?)',
    orderNum, clientId, 'Pending', 0, 'Bank Transfer', now
  );
  const orderId = Number(orderRes.insertId);

  const invNum = await nextNumber('invoices', 'invoice_num', 'INV-');
  const invRes = await run(
    `INSERT INTO invoices (invoice_num, client_id, order_id, date_created, date_due, status, subtotal, total, payment_method)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    invNum, clientId, orderId, today, addMonthsISO(today, 0), 'Unpaid', 0, 0, 'Bank Transfer'
  );
  const invoiceId = Number(invRes.insertId);

  let total = 0;

  // Package service
  const nextDue = addMonthsISO(today, term);
  await run(
    `INSERT INTO services (client_id, product_id, order_id, name, type, billing_cycle, term_months, recurring_amount, setup_fee, status, reg_date, next_due_date, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    clientId, pkg.id, orderId, `SahabatAI ${pkg.name}`, 'package',
    TERM_LABELS[term] || `${term} Bulan`, term, recurring, setup, 'Pending', today, nextDue, now
  );
  await run('INSERT INTO invoice_items (invoice_id, type, description, amount) VALUES (?,?,?,?)',
    invoiceId, 'package', `SahabatAI ${pkg.name} — ${TERM_LABELS[term] || term + ' Bulan'} (${today} s/d ${nextDue})`, recurring);
  total += recurring;
  if (setup > 0) {
    await run('INSERT INTO invoice_items (invoice_id, type, description, amount) VALUES (?,?,?,?)',
      invoiceId, 'setup', `Setup Fee (one-time) — SahabatAI ${pkg.name}`, setup);
    total += setup;
  }

  // Add-ons (Training User etc.) — one-time each, no setup fee.
  for (const a of cart.addons || []) {
    const addon = await get('SELECT * FROM products WHERE id = ?', a.id);
    if (!addon) continue;
    const qty = Math.max(1, Number(a.qty) || 1);
    const lineAmount = addon.price_3 * qty;
    await run(
      `INSERT INTO services (client_id, product_id, order_id, name, type, billing_cycle, term_months, recurring_amount, setup_fee, status, reg_date, next_due_date, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      clientId, addon.id, orderId, `${addon.name} x${qty}`, 'addon', 'One Time', 0, lineAmount, 0, 'Pending', today, null, now
    );
    await run('INSERT INTO invoice_items (invoice_id, type, description, amount) VALUES (?,?,?,?)',
      invoiceId, 'addon', `${addon.name} (x${qty})`, lineAmount);
    total += lineAmount;
  }

  await run('UPDATE invoices SET subtotal = ?, total = ? WHERE id = ?', total, total, invoiceId);
  await run('UPDATE orders SET amount = ? WHERE id = ?', total, orderId);

  return {
    order: await get('SELECT * FROM orders WHERE id = ?', orderId),
    invoice: await get('SELECT * FROM invoices WHERE id = ?', invoiceId),
  };
}

// Activate an order: mark order Active, its services Active, and its invoice Paid.
async function activateOrder(orderId) {
  const order = await get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!order) return;
  await run("UPDATE orders SET status = 'Active' WHERE id = ?", orderId);
  await run("UPDATE services SET status = 'Active' WHERE order_id = ?", orderId);
  const inv = await get("SELECT * FROM invoices WHERE order_id = ?", orderId);
  if (inv && inv.status !== 'Paid') {
    await run("UPDATE invoices SET status = 'Paid', date_paid = ? WHERE id = ?", todayISO(), inv.id);
  }
}

// Mark a single invoice paid; if it belongs to an order, activate that order too.
async function markInvoicePaid(invoiceId) {
  const inv = await get('SELECT * FROM invoices WHERE id = ?', invoiceId);
  if (!inv || inv.status === 'Paid') return;
  await run("UPDATE invoices SET status = 'Paid', date_paid = ? WHERE id = ?", todayISO(), invoiceId);
  if (inv.order_id) await activateOrder(inv.order_id);
}

// Renew a package service: extend next due date, create a new Unpaid invoice WITHOUT setup fee.
async function renewService(serviceId) {
  const svc = await get('SELECT * FROM services WHERE id = ?', serviceId);
  if (!svc || svc.type !== 'package') return null;
  const today = todayISO();
  const base = svc.next_due_date && svc.next_due_date > today ? svc.next_due_date : today;
  const newDue = addMonthsISO(base, svc.term_months || 12);

  const invNum = await nextNumber('invoices', 'invoice_num', 'INV-');
  const invRes = await run(
    `INSERT INTO invoices (invoice_num, client_id, order_id, date_created, date_due, status, subtotal, total, payment_method, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    invNum, svc.client_id, null, today, today, 'Unpaid', svc.recurring_amount, svc.recurring_amount, 'Bank Transfer', 'Renewal'
  );
  const invoiceId = Number(invRes.insertId);
  await run('INSERT INTO invoice_items (invoice_id, type, description, amount) VALUES (?,?,?,?)',
    invoiceId, 'renewal', `Renewal ${svc.name} — ${svc.billing_cycle} (${base} s/d ${newDue}) [tanpa setup fee]`, svc.recurring_amount);
  await run('UPDATE services SET next_due_date = ? WHERE id = ?', newDue, serviceId);
  return await get('SELECT * FROM invoices WHERE id = ?', invoiceId);
}

module.exports = {
  TERM_LABELS,
  termPrice,
  isFirstPurchase,
  createOrder,
  activateOrder,
  markInvoicePaid,
  renewService,
};
