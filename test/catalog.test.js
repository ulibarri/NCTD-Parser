'use strict';

// passenger_catalog (CATALOG-001): AT-21 to AT-27; companion names v2.3.0: AT-31 to AT-33.

const test = require('node:test');
const assert = require('node:assert/strict');
const { row, run, catalog } = require('./helpers');

const codes = (r) => r.exceptions.map((e) => e.code);

test('AT-21 passenger in the catalog: names and phone come from the catalog, catalog unchanged', async () => {
  const cat = catalog([{ 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' }]);
  const r = await run([row({ 'Client Name': 'DOE ,JANIE', Comments: 'CELL 858-555-0199' })], { catalog: cat });
  const d = r.destinationRows[0];
  assert.equal(d['First Name'], 'JANE');
  assert.equal(d['Last Name'], 'DOE');
  assert.equal(d['Primary Phone'], '7605550101');
  assert.equal(d['Tobi MRN'], '1001');
  assert.deepEqual(r.catalog.rows, [{ 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' }]);
  assert.equal(r.summary.catalogMatched, 1);
  assert.equal(r.summary.pasajerosAdded, 0);
});

test('AT-22 new passenger with a phone: appended with that phone', async () => {
  const cat = catalog([{ 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' }]);
  const r = await run([row({ 'Client ID': '1002', 'Client Name': 'ROE,RICHARD', Comments: 'H: 760-555-0102' })], { catalog: cat });
  assert.deepEqual(r.catalog.rows.at(-1), { 'First Name': 'RICHARD', 'Last Name': 'ROE', 'MRN Number': '1002', Telephone: '7605550102' });
  assert.equal(r.summary.pasajerosAdded, 1);
});

test('AT-23 new passenger without a phone: stored with 8584020500', async () => {
  const r = await run([row()], { catalog: catalog([]) });
  assert.equal(r.catalog.rows[0].Telephone, '8584020500');
});

test('AT-24 new passenger twice in the same file: the first source row defines the values', async () => {
  // first source row (07:55) has no phone; the later one (15:00) does
  const r = await run([row(), row({ PUTime: '15:00', PUAddress: '9 OTHER RD', Comments: 'C: 760-555-0110' })], { catalog: catalog([]) });
  assert.deepEqual(r.destinationRows.map((d) => d['Primary Phone']), ['8584020500', '8584020500']);
  assert.equal(r.catalog.rows.length, 1);
});

test('AT-24b the next day the same passenger keeps the catalog phone', async () => {
  const day1 = await run([row()], { catalog: catalog([]) });
  const day2 = await run([row({ TripDate: '10/24/2026', Comments: 'C: 760-555-0110' })], { catalog: catalog(day1.catalog.rows) });
  assert.equal(day2.destinationRows[0]['Primary Phone'], '8584020500');
  assert.equal(day2.summary.pasajerosAdded, 0);
});

test('AT-25 new PCA: own catalog row', async () => {
  const r = await run([row(), row({ 'Passenger Ty': 'PCA', Comments: 'PCA CELL 760-555-0120' })], { catalog: catalog([]) });
  assert.deepEqual(r.catalog.rows, [
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '8584020500' },
    { 'First Name': 'JANE-PCA', 'Last Name': 'DOE', 'MRN Number': '1001PCA', Telephone: '7605550120' },
  ]);
});

test('AT-26 legacy catalog MRN 1001_PCA matches Tobi MRN 1001PCA', async () => {
  const cat = catalog([{ 'First Name': 'JANE - PCA', 'Last Name': 'DOE', 'MRN Number': '1001_PCA', Telephone: '7605550130' }]);
  const r = await run([row({ 'Passenger Ty': 'PCA' })], { catalog: cat });
  assert.equal(r.destinationRows[0]['Primary Phone'], '7605550130');
  // CATALOG-NAME-MIGRATION-003: legacy " - PCA" becomes -PCA
  assert.equal(r.destinationRows[0]['First Name'], 'JANE-PCA');
  assert.equal(r.destinationRows[0]['Last Name'], 'DOE');
  assert.equal(r.summary.pasajerosAdded, 0);
});

test('AT-27 no catalog uploaded: warning and every passenger is new', async () => {
  const r = await run([row()]);
  assert.ok(codes(r).includes('NO_PASSENGER_CATALOG'));
  assert.equal(r.summary.catalogProvided, false);
  assert.equal(r.summary.pasajerosAdded, 1);
});

test('catalog: repeated MRN keeps the first row; invalid phone is reported and kept', async () => {
  const cat = catalog([
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '760-555-01' },
    { 'First Name': 'JANET', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550199' },
  ]);
  const r = await run([row()], { catalog: cat });
  assert.equal(r.destinationRows[0]['First Name'], 'JANE');
  assert.equal(r.destinationRows[0]['Primary Phone'], '76055501');
  assert.ok(codes(r).includes('CATALOG_DUPLICATE_MRN'));
  assert.ok(codes(r).includes('CATALOG_PHONE_INVALID'));
  assert.equal(r.catalog.rows.length, 2);
});

const ID = { PCA: 'PCA', COM: 'COM', COMP: 'COM' };
for (const type of ['PCA', 'COM', 'COMP']) {
  test(`AT-31 new ${type} with Client Name ALLOUCHE,DEANNE: First Name -${ID[type]}, MRN ${ID[type]}`, async () => {
    const r = await run([row({ 'Client Name': 'ALLOUCHE,DEANNE', 'Client ID': '82475', 'Passenger Ty': type })], { catalog: catalog([]) });
    const d = r.destinationRows[0];
    const sfx = ID[type];
    assert.equal(d['First Name'], `DEANNE-${sfx}`);
    assert.equal(d['Last Name'], 'ALLOUCHE');
    assert.equal(d['Tobi MRN'], `82475${sfx}`);
    assert.equal(d['Vendor ID'], `82475202610230755${sfx}`);
    assert.equal(d['Leg ID'], `82475202610230755${sfx}A`);
    assert.deepEqual(r.catalog.rows, [{ 'First Name': `DEANNE-${sfx}`, 'Last Name': 'ALLOUCHE', 'MRN Number': `82475${sfx}`, Telephone: '8584020500' }]);
  });
}

test('AT-53 legacy suffixes in the manifest name are removed once (COMPANION-*-CLEANUP)', async () => {
  const r = await run([
    row({ 'Client Name': 'ALLOUCHE COMPANION,DEANNE - PCA', 'Client ID': '82475PCA', 'Passenger Ty': 'PCA' }),
    row({ 'Client Name': 'SMITH COM,ANN-PCA', 'Client ID': '5', 'Passenger Ty': 'COM', PUTime: '09:00:00' }),
    row({ 'Client Name': 'PCAREZ,PCARLA', 'Client ID': '6', 'Passenger Ty': 'PCA', PUTime: '10:00:00' }),
    row({ 'Client Name': 'COMPTON,MARIA-COM', 'Client ID': '7', 'Passenger Ty': 'COMP', PUTime: '11:00:00' }),
    row({ 'Client Name': 'ROE PCA,JOE', 'Client ID': '8', PUTime: '12:00:00' }),
  ]);
  const by = (mrn) => r.destinationRows.find((d) => d['Tobi MRN'] === mrn);
  assert.deepEqual([by('82475PCA')['Last Name'], by('82475PCA')['First Name']], ['ALLOUCHE', 'DEANNE-PCA']);
  assert.deepEqual([by('5COM')['Last Name'], by('5COM')['First Name']], ['SMITH', 'ANN-COM']);
  assert.deepEqual([by('6PCA')['Last Name'], by('6PCA')['First Name']], ['PCAREZ', 'PCARLA-PCA']);
  assert.deepEqual([by('7COM')['Last Name'], by('7COM')['First Name']], ['COMPTON', 'MARIA-COM']);
  assert.deepEqual([by('8')['Last Name'], by('8')['First Name']], ['ROE PCA', 'JOE']); // clients are not touched
});

test('AT-32 old-format companion catalog rows are migrated to v2.7 names (CATALOG-NAME-MIGRATION-003)', async () => {
  const cat = catalog([
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' },
    { 'First Name': 'DEANNE', 'Last Name': 'ALLOUCHE COMPANION', 'MRN Number': '82475PCA', Telephone: '7605550102' },
    { 'First Name': 'ANN - PCA', 'Last Name': 'SMITH', 'MRN Number': '5_PCA', Telephone: '7605550103' },
    { 'First Name': 'MARIA', 'Last Name': 'LOPEZ COM', 'MRN Number': '3333COM', Telephone: '7605550104' },
  ]);
  const r = await run([row({ 'Client Name': 'ALLOUCHE,DEANNE', 'Client ID': '82475', 'Passenger Ty': 'PCA' })], { catalog: cat });
  const d = r.destinationRows[0];
  assert.equal(d['First Name'], 'DEANNE-PCA');
  assert.equal(d['Last Name'], 'ALLOUCHE');
  assert.equal(d['Tobi MRN'], '82475PCA');
  assert.equal(d['Primary Phone'], '7605550102');
  assert.deepEqual(r.catalog.rows, [
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' },
    { 'First Name': 'DEANNE-PCA', 'Last Name': 'ALLOUCHE', 'MRN Number': '82475PCA', Telephone: '7605550102' },
    { 'First Name': 'ANN-PCA', 'Last Name': 'SMITH', 'MRN Number': '5_PCA', Telephone: '7605550103' },
    { 'First Name': 'MARIA-COM', 'Last Name': 'LOPEZ', 'MRN Number': '3333COM', Telephone: '7605550104' },
  ]);
  assert.equal(r.summary.catalogMigrated, 3);
  assert.equal(r.summary.pasajerosAdded, 0);
});

test('AT-33 reprocessing a catalog in the v2.7 format changes nothing', async () => {
  const day1 = await run([row({ 'Client Name': 'ALLOUCHE,DEANNE', 'Client ID': '82475', 'Passenger Ty': 'PCA' })], { catalog: catalog([]) });
  assert.deepEqual(day1.catalog.rows, [{ 'First Name': 'DEANNE-PCA', 'Last Name': 'ALLOUCHE', 'MRN Number': '82475PCA', Telephone: '8584020500' }]);
  const day2 = await run([row({ 'Client Name': 'ALLOUCHE,DEANNE', 'Client ID': '82475', 'Passenger Ty': 'PCA' })], { catalog: catalog(day1.catalog.rows) });
  assert.deepEqual(day2.catalog.rows, day1.catalog.rows);
  assert.equal(day2.summary.catalogMigrated, 0);
  assert.equal(day2.summary.catalogMatched, 1);
  assert.equal(day2.destinationRows[0]['First Name'], 'DEANNE-PCA');
  assert.equal(day2.destinationRows[0]['Last Name'], 'ALLOUCHE');
});

test('migration does not touch client rows and does not change the uploaded table', async () => {
  const cat = catalog([{ 'First Name': 'JOE - PCA', 'Last Name': 'ROE COMPANION', 'MRN Number': '2002', Telephone: '7605550103' }]);
  const before = JSON.stringify(cat);
  const r = await run([row()], { catalog: cat });
  assert.deepEqual(r.catalog.rows[0], { 'First Name': 'JOE - PCA', 'Last Name': 'ROE COMPANION', 'MRN Number': '2002', Telephone: '7605550103' });
  assert.equal(r.summary.catalogMigrated, 0);
  assert.equal(JSON.stringify(cat), before);
});
