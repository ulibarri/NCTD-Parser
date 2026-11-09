'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const F = require('../src/parser/fields');
const D = require('../src/parser/dates');
const { readTable } = require('../src/parser/ingestion');
const { toCsv, outputName } = require('../src/parser/csv-export');
const { updatePasajeros } = require('../src/parser/pasajeros');
const { rules } = require('./helpers');

const IND = rules.field_rules.pickup_address.secondary_indicators;

test('splitAddress handles glued and spaced units', () => {
  const cases = [
    ['2245 CAMINO VIDA ROBLE  UNIT100', '2245 CAMINO VIDA ROBLE', 'UNIT100'],
    ['1475 RANCHEROS DR  UNIT 196', '1475 RANCHEROS DR', 'UNIT 196'],
    ['100 SANTA FE DR  STE 100', '100 SANTA FE DR', 'STE 100'],
    ['55 LAS FLORES DR  SPC131', '55 LAS FLORES DR', 'SPC131'],
    ['12 LINDA VISTA DR  SP 307', '12 LINDA VISTA DR', 'SP 307'],
    ['9 SYCAMORE AVE  # 159', '9 SYCAMORE AVE', '# 159'],
    ['40 N BROADWAY  #21', '40 N BROADWAY', '#21'],
    ['10 OAK ST APT B', '10 OAK ST', 'APT B'],
    ['413 AUTUMN DR 220', '413 AUTUMN DR', '220'],
    ['3625 VISTA OCEANA 13', '3625 VISTA OCEANA 13', ''],
    ['1 SPA WAY', '1 SPA WAY', ''],
    ['700 W VALLEY PKY', '700 W VALLEY PKY', ''],
  ];
  for (const [input, street, suite] of cases) assert.deepEqual(F.splitAddress(input, IND), { street, suite }, input);
});

test('dates and times', () => {
  assert.deepEqual(D.parseTripDate('10/23/2026'), { y: 2026, m: 10, d: 23 });
  assert.deepEqual(D.parseTripDate('10/23/26'), { y: 2026, m: 10, d: 23 });
  assert.deepEqual(D.parseTripDate('2026-10-23'), { y: 2026, m: 10, d: 23 });
  assert.deepEqual(D.parseTripDate('46318'), { y: 2026, m: 10, d: 23 });
  assert.equal(D.parseTripDate('02/30/2026'), null);
  assert.deepEqual(D.parseTime('07:55'), { h: 7, mi: 55, s: 0 });
  assert.deepEqual(D.parseTime('0.5'), { h: 12, mi: 0, s: 0 });
  assert.equal(D.parseTime('25:00'), null);
  assert.equal(D.yymmdd({ y: 2026, m: 11, d: 12 }), '261112');
});

test('XLSX ingestion: typed cells become text, blank rows ignored, headers matched', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow([' client name ', 'Client ID', 'TripDate', 'PUTime', 'PUZipcode']);
  ws.addRow(['DOE ,JANE', 82475, new Date(Date.UTC(2026, 9, 23)), new Date(Date.UTC(1899, 11, 30, 7, 55)), 92014]);
  ws.addRow([]);
  ws.getCell('A10').value = null;
  const buffer = await wb.xlsx.writeBuffer();
  const t = await readTable(buffer, 'x.xlsx', {
    expectedColumns: rules.source_columns, requiredColumns: ['Client Name', 'Client ID'], allowedExtensions: ['xlsx', 'csv'],
  });
  assert.equal(t.rows.length, 1);
  assert.deepEqual(t.rows[0].values, { 'Client Name': 'DOE ,JANE', 'Client ID': '82475', TripDate: '10/23/2026', PUTime: '07:55:00', PUZipcode: '92014' });
});

test('ingestion rejects missing columns and unsupported formats', async () => {
  const opts = { expectedColumns: rules.source_columns, requiredColumns: ['Client Name', 'PUCity'], allowedExtensions: ['xlsx', 'csv'] };
  await assert.rejects(readTable(Buffer.from('Client Name\nA\n'), 'a.csv', opts), (e) => e.code === 'MISSING_COLUMNS' && e.details.missing[0] === 'PUCity');
  await assert.rejects(readTable(Buffer.from('x'), 'a.txt', opts), (e) => e.code === 'UNSUPPORTED_FORMAT');
});

test('CSV export: BOM, header and quoting; output names', () => {
  const csv = toCsv(['A', 'B'], [{ A: '1,2', B: 'x' }]);
  assert.ok(csv.startsWith('﻿A,B\r\n"1,2",x'));
  assert.equal(outputName('NCTD_Trips_10.23.26_1.xlsx', '_TOBI'), 'NCTD_Trips_10.23.26_1_TOBI.CSV');
});

test('Pasajeros (provisional): appends clients not already listed', () => {
  const pasajeros = {
    headers: ['First Name', 'Last Name', 'MRN Number', 'Telephone'],
    columns: ['First Name', 'Last Name', 'MRN Number', 'Telephone'],
    rows: [{ values: { 'MRN Number': '1001' }, original: ['JANE', 'DOE', '1001', '7605550101'] }],
  };
  const out = [
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'Tobi MRN': '1001', 'Primary Phone': '9876543210' },
    { 'First Name': 'JANE - PCA', 'Last Name': 'DOE', 'Tobi MRN': '1001_PCA', 'Primary Phone': '9876543210' },
    { 'First Name': 'RICHARD', 'Last Name': 'ROE', 'Tobi MRN': '1002', 'Primary Phone': '7605550199' },
  ];
  const r = updatePasajeros(pasajeros, out, '9876543210');
  assert.equal(r.added, 1);
  assert.deepEqual(r.rows[1], { 'First Name': 'RICHARD', 'Last Name': 'ROE', 'MRN Number': '1002', Telephone: '7605550199' });
});

test('Pasajeros upload requires First Name, Last Name, MRN Number and Telephone', async () => {
  const { PASAJEROS_COLUMNS } = require('../src/parser/pasajeros');
  assert.deepEqual(PASAJEROS_COLUMNS, ['First Name', 'Last Name', 'MRN Number', 'Telephone']);
  const opts = { expectedColumns: PASAJEROS_COLUMNS, requiredColumns: PASAJEROS_COLUMNS, allowedExtensions: ['csv'] };
  const ok = await readTable(Buffer.from('First Name,Last Name,MRN Number,Telephone\nJANE,DOE,1001,7605550101\n'), 'p.csv', opts);
  assert.equal(ok.rows[0].values['MRN Number'], '1001');
  await assert.rejects(
    readTable(Buffer.from('First Name,Last Name,MRN Number (id),Telephone\nJANE,DOE,1001,7605550101\n'), 'p.csv', opts),
    (e) => e.code === 'MISSING_COLUMNS' && e.details.missing.join() === 'MRN Number',
  );
});
