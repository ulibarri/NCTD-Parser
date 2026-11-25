'use strict';

// Reads XLSX or CSV files into rows of text values.
// Every cell is converted to a string so that validation works the same way
// for both formats, while the original text is kept for Invalid Trips.

const path = require('node:path');
const ExcelJS = require('exceljs');
const { parse } = require('csv-parse/sync');
const { pad } = require('./dates');

class IngestionError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

function normalizeHeader(h) {
  return String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dateCellToText(dt) {
  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const h = dt.getUTCHours();
  const mi = dt.getUTCMinutes();
  const s = dt.getUTCSeconds();
  const timeOnly = y < 1900 || (y === 1900 && mo === 1 && d === 0);
  const time = `${pad(h)}:${pad(mi)}:${pad(s)}`;
  if (timeOnly) return time;
  const date = `${pad(mo)}/${pad(d)}/${y}`;
  return h === 0 && mi === 0 && s === 0 ? date : `${date} ${time}`;
}

function cellToText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return dateCellToText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellToText(value.result);
    if ('text' in value) return cellToText(value.text);
    if ('error' in value) return '';
  }
  return String(value);
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (err) {
    throw new IngestionError('FILE_UNREADABLE', { reason: err.message });
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new IngestionError('FILE_EMPTY');
  const width = ws.columnCount;
  const table = [];
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const values = [];
    for (let c = 1; c <= width; c += 1) values.push(cellToText(row.getCell(c).value));
    table.push({ rowNumber: r, values });
  }
  return table;
}

function readCsv(buffer) {
  let records;
  try {
    records = parse(buffer, { bom: true, relax_column_count: true, skip_empty_lines: false });
  } catch (err) {
    throw new IngestionError('FILE_UNREADABLE', { reason: err.message });
  }
  return records.map((values, i) => ({ rowNumber: i + 1, values: values.map((v) => v ?? '') }));
}

const isBlankRow = (values) => values.every((v) => String(v).trim() === '');

/** Letters and digits only, lower case: "Client ID #" -> "clientid", "DR Appt." -> "drappt". */
const headerKey = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const hasValue = (table, from, i) => table.slice(from).some((r) => String(r.values[i] ?? '').trim() !== '');

/**
 * v2.14.0 HEADER-PROFILES-001: finds the header profile of a Viajes file.
 * The standard profile (source_columns) is tried first; then each alternate
 * profile, which matches when every one of its headers is present.
 * @returns {{ id: string, columns: string[], indices: number[], headers: string[], absent: string[] }}
 */
function matchProfile(table, headerIndex, rawHeaders, width, { expectedColumns, requiredColumns, headerProfiles }) {
  const named = rawHeaders.slice(0, width);
  const canonicalByNorm = new Map(expectedColumns.map((c) => [normalizeHeader(c), c]));
  const stdColumns = named.map((h) => canonicalByNorm.get(normalizeHeader(h)) || h);
  const stdMissing = requiredColumns.filter((c) => !stdColumns.includes(c));
  const indices = named.map((_, i) => i);
  if (!stdMissing.length) {
    return { id: (headerProfiles && headerProfiles.standard_profile_id) || 'standard', columns: stdColumns, indices, headers: named, absent: [] };
  }
  if (!headerProfiles) throw new IngestionError('MISSING_COLUMNS', { missing: stdMissing });

  const tried = [{ id: headerProfiles.standard_profile_id || 'standard', missing: stdMissing }];
  for (const p of headerProfiles.alternate_profiles || []) {
    const byKey = new Map();
    named.forEach((h, i) => { const k = headerKey(h); if (k && !byKey.has(k)) byKey.set(k, i); });
    const targetAt = new Map();
    const missing = [];
    for (const [target, source] of Object.entries(p.columns)) {
      const i = byKey.get(headerKey(source));
      if (i === undefined) missing.push(source);
      else targetAt.set(i, target);
    }
    if (missing.length) { tried.push({ id: p.id, missing }); continue; }
    const columns = named.map((h, i) => targetAt.get(i) || h);
    const headers = [...named];
    const idx = [...indices];
    const u = p.unheaded_column;
    if (u) {
      // The one column without a header that has values, wherever it sits
      // (T in the file of Nov 20, AB in the file of Nov 24).
      const maxWidth = Math.max(...table.map((r) => r.values.length));
      for (let i = 0; i < maxWidth; i += 1) {
        if (String(rawHeaders[i] ?? '').trim() === '' && hasValue(table, headerIndex + 1, i)) {
          columns.push(u.target); headers.push(u.target); idx.push(i);
          break;
        }
      }
    }
    const absent = expectedColumns.filter((c) => !columns.includes(c));
    return { id: p.id, columns, indices: idx, headers, absent };
  }
  throw new IngestionError('UNKNOWN_HEADER_FORMAT', {
    profiles: tried.map((x) => x.id),
    missing: tried.reduce((a, b) => (b.missing.length < a.missing.length ? b : a)).missing,
    closest: tried.reduce((a, b) => (b.missing.length < a.missing.length ? b : a)).id,
  });
}

/**
 * Reads a file and maps its columns to the expected names.
 * With headerProfiles (Viajes, v2.14.0) the header may follow any known
 * profile; the result always uses the canonical column names.
 * @returns {{ headers: string[], columns: string[], profile: string|null, rows: { rowNumber: number, values: Object<string,string>, original: string[] }[] }}
 */
async function readTable(buffer, filename, { expectedColumns, requiredColumns, allowedExtensions, headerProfiles }) {
  const ext = path.extname(filename || '').toLowerCase().replace('.', '');
  if (!allowedExtensions.includes(ext)) throw new IngestionError('UNSUPPORTED_FORMAT', { ext, allowed: allowedExtensions });

  const table = ext === 'xlsx' ? await readXlsx(buffer) : readCsv(buffer);
  const headerIndex = table.findIndex((r) => !isBlankRow(r.values));
  if (headerIndex === -1) throw new IngestionError('FILE_EMPTY');

  const headerRow = table[headerIndex].values;
  // Drop trailing empty header cells (formatted but unused columns).
  let width = headerRow.length;
  while (width > 0 && String(headerRow[width - 1]).trim() === '') width -= 1;
  const rawHeaders = headerRow.map((h) => String(h).replace(/\s+/g, ' ').trim());

  const m = matchProfile(table, headerIndex, rawHeaders, width, { expectedColumns, requiredColumns, headerProfiles });

  const rows = [];
  for (const r of table.slice(headerIndex + 1)) {
    const original = m.indices.map((i) => r.values[i] ?? '');
    if (isBlankRow(original)) continue; // fully empty rows are ignored
    const values = {};
    m.columns.forEach((c, i) => {
      if (!(c in values)) values[c] = original[i];
    });
    for (const c of m.absent) values[c] = '';
    rows.push({ rowNumber: r.rowNumber, values, original });
  }
  return { headers: m.headers, columns: m.columns, profile: headerProfiles ? m.id : null, rows };
}

module.exports = { readTable, IngestionError, cellToText, headerKey };
