'use strict';
// Formatting helpers: Indonesian Rupiah + dates.

function rupiah(n) {
  const num = Math.round(Number(n) || 0);
  const s = Math.abs(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (num < 0 ? '-Rp ' : 'Rp ') + s;
}

// Store dates as ISO strings; display as e.g. "02 Jul 2026".
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function nowISO() {
  return new Date().toISOString();
}
function addMonthsISO(iso, months) {
  const d = iso ? new Date(iso) : new Date();
  d.setMonth(d.getMonth() + Number(months || 0));
  return d.toISOString().slice(0, 10);
}
function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return `${fmtDate(iso)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

module.exports = { rupiah, todayISO, nowISO, addMonthsISO, fmtDate, fmtDateTime };
