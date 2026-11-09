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

/**
 * Reads a file and maps its columns to the expected names.
 * @returns {{ headers: string[], columns: string[], rows: { rowNumber: number, values: Object<string,string>, original: string[] }[] }}
 */
async function readTable(buffer, filename, { expectedColumns, requiredColumns, allowedExtensions }) {
  const ext = path.extname(filename || '').toLowerCase().replace('.', '');
  if (!allowedExtensions.includes(ext)) throw new IngestionError('UNSUPPORTED_FORMAT', { ext, allowed: allowedExtensions });

  const table = ext === 'xlsx' ? await readXlsx(buffer) : readCsv(buffer);
  const headerIndex = table.findIndex((r) => !isBlankRow(r.values));
  if (headerIndex === -1) throw new IngestionError('FILE_EMPTY');

  const headerRow = table[headerIndex].values;
  // Drop trailing empty header cells (formatted but unused columns).
  let width = headerRow.length;
  while (width > 0 && String(headerRow[width - 1]).trim() === '') width -= 1;
  const headers = headerRow.slice(0, width).map((h) => String(h).replace(/\s+/g, ' ').trim());

  const canonicalByNorm = new Map(expectedColumns.map((c) => [normalizeHeader(c), c]));
  const columns = headers.map((h) => canonicalByNorm.get(normalizeHeader(h)) || h);

  const missing = requiredColumns.filter((c) => !columns.includes(c));
  if (missing.length) throw new IngestionError('MISSING_COLUMNS', { missing });

  const rows = [];
  for (const r of table.slice(headerIndex + 1)) {
    const original = r.values.slice(0, width);
    while (original.length < width) original.push('');
    if (isBlankRow(original)) continue; // fully empty rows are ignored
    const values = {};
    columns.forEach((c, i) => {
      if (!(c in values)) values[c] = original[i];
    });
    rows.push({ rowNumber: r.rowNumber, values, original });
  }
  return { headers, columns, rows };
}

module.exports = { readTable, IngestionError, cellToText };
