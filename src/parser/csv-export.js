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

/** "Manifest 1108.xlsx" + "_TOBI" -> "Manifest 1108_TOBI.CSV" */
function outputName(sourceFilename, suffix) {
  const base = path.basename(sourceFilename || 'Viajes', path.extname(sourceFilename || ''));
  return `${base}${suffix}.CSV`;
}

module.exports = { toCsv, outputName };
