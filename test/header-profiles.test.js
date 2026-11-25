'use strict';

// v2.14.0 HEADER-PROFILES-001 (AT-91 to AT-93) and UI-LEG-ID-V2-HIDDEN-001 (AT-94).

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { stringify } = require('csv-stringify/sync');
const { rules, row } = require('./helpers');
const { createApp } = require('../server');
const { readTable } = require('../src/parser/ingestion');

const CFS = rules.source_header_profiles.alternate_profiles[0];
const CFS_HEADERS = Object.values(CFS.columns); // Client  Name, Client ID #, Date, Time ... Notes
const ABSENT = CFS.absent_columns_read_as_empty;

// Synthetic trips (no real passenger data); the 9 columns CFS_19 lacks are empty.
const trips = [
  row({ 'Client Name': 'PEREZ,ANA', 'Client ID': '7001', TripDate: '11/24/2026', PUTime: '07:35', DOAppt: '09:00', Comments: 'GATE CODE 1234', 'Run Name': 'CFS' }),
  row({ 'Client Name': 'PEREZ,ANA', 'Client ID': '7001', TripDate: '11/24/2026', PUTime: '15:00', DOAppt: '', PUAddress: '200 MISSION AVE STE 5', PUCity: 'VISTA', PUZipcode: '92081', DOAddress: '100 MAIN ST', DOCity: 'OCEANSIDE', DOZipcode: '92054', DropLocationName: '', PickUpLocationName: 'DIALYSIS - VISTA', 'Run Name': 'CFS' }),
  row({ 'Client Name': 'LOPEZ,LUIS', 'Client ID': '7002', TripDate: '11/24/2026', PUTime: '10:10', 'Passenger Ty': 'PCA', Amount: '0', DOAddress: '1622 BROADWAY A', 'Run Name': 'CFS' }),
].map((r) => ({ ...r, ...Object.fromEntries(ABSENT.map((c) => [c, ''])) }));

const standardCsv = (rows) => stringify([rules.source_columns, ...rows.map((r) => rules.source_columns.map((c) => r[c] ?? ''))]);

/** CFS_19 layout: 19 named headers, then `gap` empty columns, then Run Name without header. */
function cfsMatrix(rows, { gap = 0, drop = [] } = {}) {
  const pairs = Object.entries(CFS.columns).filter(([, src]) => !drop.includes(src));
  const header = [...pairs.map(([, src]) => src), ...Array(gap + 1).fill('')];
  const body = rows.map((r) => [...pairs.map(([target]) => r[target] ?? ''), ...Array(gap).fill(''), r['Run Name']]);
  return [header, ...body];
}

async function cfsXlsx(rows, opts) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const [i, line] of cfsMatrix(rows, opts).entries()) {
    if (i === 0) { ws.addRow(line); continue; }
    // as in the real files: Date is a date cell, Time and DR Appt. are time cells
    const [mo, d, y] = line[2].split('/').map(Number);
    const time = (hhmm) => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); return new Date(Date.UTC(1899, 11, 30, h, m)); };
    line[2] = new Date(Date.UTC(y, mo - 1, d));
    line[3] = time(line[3]);
    line[17] = time(line[17]);
    ws.addRow(line);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function withApp(fn) {
  const server = createApp({ rules, catalogStore: null }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const upload = async (name, content) => {
    const body = new FormData();
    body.append('file', new Blob([content]), name);
    const res = await fetch(`${base}/api/uploads/viajes`, { method: 'POST', body });
    return { status: res.status, data: await res.json() };
  };
  const output = async (name, content, extra = {}) => {
    const up = await upload(name, content);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ viajesUploadId: up.data.uploadId, ...extra }) });
    const job = await res.json();
    assert.equal(res.status, 200, JSON.stringify(job));
    return { up: up.data, job, csv: await (await fetch(base + job.downloads.output.url)).text() };
  };
  try { await fn({ base, upload, output }); } finally { server.close(); }
}

test('rules: v2.14.0 header profiles and hidden Leg ID V2 controls', () => {
  assert.equal(rules.specification.version, '2.14.0');
  assert.equal(rules.source_header_profiles.standard_profile_id, 'NCTD_STANDARD_29');
  assert.equal(CFS.id, 'CFS_19');
  assert.equal(CFS_HEADERS.length, 19);
  assert.equal(CFS.unheaded_column.target, 'Run Name');
  assert.equal(ABSENT.length, 9);
  // every standard column comes from CFS_19 or is read as empty
  assert.deepEqual([...Object.keys(CFS.columns), ...ABSENT, 'Run Name'].sort(), [...rules.source_columns].sort());
  assert.equal(rules.user_interface.leg_id_v2_controls.visible, false);
});

test('AT-91 CFS_19 header (XLSX, Run Name in column AB) gives the same Output as the standard header', async () => {
  await withApp(async ({ output }) => {
    const std = await output('CFS_11.24.26.csv', standardCsv(trips));
    const cfs = await output('CFS_11.24.26.xlsx', await cfsXlsx(trips, { gap: 8 }));
    assert.equal(std.up.headerProfile, 'NCTD_STANDARD_29');
    assert.equal(cfs.up.headerProfile, 'CFS_19');
    assert.equal(cfs.job.summary.rowsRead, 3);
    assert.equal(cfs.job.summary.invalidRows, 0);
    assert.equal(cfs.job.summary.exportReady, true);
    assert.equal(cfs.csv, std.csv);
    assert.match(cfs.csv, /1622 BROADWAY,A,/);
  });
});

test('AT-92 CFS_19 header (CSV, Run Name in column T): Run Name read, absent columns empty', async () => {
  const csv = stringify(cfsMatrix(trips, { gap: 0 }));
  const t = await readTable(Buffer.from(csv), 'CFS_11.20.26.csv', {
    expectedColumns: rules.source_columns, requiredColumns: ['Client Name', 'TripDate'], allowedExtensions: ['csv'], headerProfiles: rules.source_header_profiles,
  });
  assert.equal(t.profile, 'CFS_19');
  assert.equal(t.headers.length, 20);
  assert.equal(t.headers[19], 'Run Name');
  assert.equal(t.headers[0], 'Client Name'); // spaces collapsed as before
  assert.equal(t.rows[0].values['Run Name'], 'CFS');
  assert.equal(t.rows[0].values['Client ID'], '7001');
  assert.equal(t.rows[0].values.Comments, 'GATE CODE 1234');
  for (const c of ABSENT) assert.equal(t.rows[0].values[c], '', c);
  // header names compared by letters and digits only
  const odd = stringify(cfsMatrix(trips).map((r, i) => (i === 0 ? r.map((h) => h.toLowerCase().replace(/ /g, '_')) : r)));
  const t2 = await readTable(Buffer.from(odd), 'x.csv', { expectedColumns: rules.source_columns, requiredColumns: ['Client Name'], allowedExtensions: ['csv'], headerProfiles: rules.source_header_profiles });
  assert.equal(t2.profile, 'CFS_19');
  await withApp(async ({ output }) => {
    const std = await output('CFS_11.20.26.csv', standardCsv(trips));
    const cfs = await output('CFS_11.20.26.csv', csv);
    assert.equal(cfs.csv, std.csv);
  });
});

test('AT-93 a header that matches neither layout gives UNKNOWN_HEADER_FORMAT', async () => {
  await withApp(async ({ upload }) => {
    const noNotes = await upload('CFS_11.25.26.csv', stringify(cfsMatrix(trips, { drop: ['Notes'] })));
    assert.equal(noNotes.status, 400);
    assert.equal(noNotes.data.error, 'UNKNOWN_HEADER_FORMAT');
    assert.deepEqual(noNotes.data.details.missing, ['Notes']);
    assert.equal(noNotes.data.details.closest, 'CFS_19');
    const other = await upload('other.csv', 'Name,Date,Address\nPEREZ,11/24/2026,1 MAIN ST\n');
    assert.equal(other.status, 400);
    assert.equal(other.data.error, 'UNKNOWN_HEADER_FORMAT');
    assert.deepEqual(other.data.details.profiles, ['NCTD_STANDARD_29', 'CFS_19']);
  });
});

test('AT-94 Leg ID V2 switches are hidden; the API still accepts legIdV2Mode', async () => {
  await withApp(async ({ base, output }) => {
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /<div id="legIdV2Controls" hidden>/);
    assert.match(html, /id="legIdV2Toggle"/); // still in the page, only hidden
    const on = await output('CFS_11.24.26.csv', standardCsv(trips), { legIdV2Mode: true });
    assert.equal(on.job.summary.legIdV2Mode, true);
  });
  const shown = { ...rules, user_interface: { leg_id_v2_controls: { visible: true } } };
  const server = createApp({ rules: shown, catalogStore: null }).listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`)).text();
    assert.match(html, /<div id="legIdV2Controls">/);
  } finally { server.close(); }
});
