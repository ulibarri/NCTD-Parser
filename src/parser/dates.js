'use strict';

// Date and time parsing for the formats listed in
// required_field_validation.format_rules. All values arrive as strings
// (ingestion converts Excel cells to text first).

const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

function isValidYMD(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Parses TripDate. Returns { y, m, d } or null. */
function parseTripDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m;
  // MM/DD/YYYY or MM/DD/YY
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/))) {
    let y = Number(m[3]);
    if (m[3].length === 2) y += 2000;
    const r = { y, m: Number(m[1]), d: Number(m[2]) };
    return isValidYMD(r.y, r.m, r.d) ? r : null;
  }
  // YYYY-MM-DD
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    const r = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
    return isValidYMD(r.y, r.m, r.d) ? r : null;
  }
  // Excel serial date (whole days; a .0 suffix is accepted)
  if ((m = s.match(/^(\d{1,6})(?:\.0+)?$/))) {
    const serial = Number(m[1]);
    if (serial < 1 || serial > 2958465) return null;
    const dt = new Date(EXCEL_EPOCH_UTC + serial * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  return null;
}

/** Parses PUTime / DOAppt. Returns { h, mi, s } or null. */
function parseTime(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) {
    const r = { h: Number(m[1]), mi: Number(m[2]), s: Number(m[3] || 0) };
    return r.h < 24 && r.mi < 60 && r.s < 60 ? r : null;
  }
  // Excel fractional day: 0 <= x < 1
  if ((m = s.match(/^0?\.\d+$|^0$/))) {
    const frac = Number(s);
    if (!(frac >= 0 && frac < 1)) return null;
    let total = Math.round(frac * 86400);
    if (total >= 86400) total = 86399;
    return { h: Math.floor(total / 3600), mi: Math.floor((total % 3600) / 60), s: total % 60 };
  }
  return null;
}

function ymdKey(d) {
  return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
}

/** YYMMDD prefix for Journey ID. */
function yymmdd(d) {
  return `${pad(d.y % 100)}${pad(d.m)}${pad(d.d)}`;
}

/** Destination format YYYY-MM-DD HH:mm:ss.SSS */
function formatDestination(d, t) {
  const time = t || { h: 0, mi: 0, s: 0 };
  return `${d.y}-${pad(d.m)}-${pad(d.d)} ${pad(time.h)}:${pad(time.mi)}:${pad(time.s)}.000`;
}

/** Display format used in the UI and in the date-changed preview: MM/DD/YYYY */
function formatDisplayDate(d) {
  return `${pad(d.m)}/${pad(d.d)}/${d.y}`;
}

function timeKey(t) {
  return `${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}`;
}

module.exports = {
  parseTripDate,
  parseTime,
  ymdKey,
  yymmdd,
  formatDestination,
  formatDisplayDate,
  timeKey,
  pad,
};
