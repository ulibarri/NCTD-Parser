'use strict';

const path = require('node:path');
const { stringify } = require('csv-stringify/sync');

/** CSV with header row, UTF-8 BOM (so Excel shows accents) and CRLF line endings. */
function toCsv(columns, rows) {
  const body = stringify(rows.map((r) => columns.map((c) => r[c] ?? '')), {
    header: true,
    columns,
    record_delimiter: 'windows',
    quoted_match: /^\s|\s$/,
  });
  return `﻿${body}`;
}

const pad = (n) => String(n).padStart(2, '0');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Writes a date {y,m,d} in a format such as "MM.DD.YY", "M-D-YYYY", "YYYYMMDD". */
function formatDate(date, format) {
  return format.replace(/YYYY|YY|MM|DD|M|D/g, (t) => ({
    YYYY: String(date.y),
    YY: pad(date.y % 100),
    MM: pad(date.m),
    DD: pad(date.d),
    M: String(date.m),
    D: String(date.d),
  })[t]);
}

/**
 * Replaces the original trip date inside a base name with the new date, in the
 * same format (output_file_naming.when_trip_date_changed). Falls back to
 * appending "_<new date>" when the original date is not in the name.
 */
function renameWithDate(base, originalDate, newDate, rule) {
  // Longer formats first, so "10.23.2026" is not read as "10.23.20".
  const formats = [...rule.recognized_formats].sort((a, b) => b.length - a.length);
  for (const format of formats) {
    const token = formatDate(originalDate, format);
    const re = new RegExp(`(?<!\\d)${escapeRe(token)}(?!\\d)`);
    if (re.test(base)) return base.replace(re, formatDate(newDate, format));
  }
  return `${base}_${formatDate(newDate, rule.fallback_format)}`;
}

/**
 * Output file name for one of the files in output_file_naming.files.
 * @param {string} sourceFilename uploaded file name
 * @param {'destination'|'invalid_trips'|'pasajeros_updated'} kind
 * @param {object} naming rules.file_contract.output_file_naming
 * @param {{ originalDate?: {y,m,d}, newDate?: {y,m,d} }} [dates] set when the trip date was changed
 */
function outputName(sourceFilename, kind, naming, dates = {}) {
  const fallback = kind === 'pasajeros_updated' ? 'Pasajeros' : 'Viajes';
  const name = sourceFilename || fallback;
  let base = path.basename(name, path.extname(name)) || fallback;
  const changed = naming.when_trip_date_changed;
  if (dates.newDate && dates.originalDate && changed.applies_to.includes(kind)) {
    base = renameWithDate(base, dates.originalDate, dates.newDate, changed);
  }
  return `${base}${naming.files[kind].suffix}${naming.extension}`;
}

module.exports = { toCsv, outputName, renameWithDate, formatDate };
