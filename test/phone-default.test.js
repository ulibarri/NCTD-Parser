'use strict';

// v2.8.2: PHONE-DEFAULT-002 (AT-63) and CATALOG-PHONE-MIGRATION-001 (AT-64).

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, row, run, catalog } = require('./helpers');

const OLD = '9876543210';
const NEW = '8584020500';
const has = (r, v) => JSON.stringify([r.destinationRows, r.catalog.rows]).includes(v);

test('rules: v2.8.2 Primary Phone fallback and catalog phone migration', () => {
  assert.ok(rules.specification.changelog.some((c) => c.version === '2.8.2'));
  assert.equal(rules.field_rules.phones['Primary Phone'].default, NEW);
  assert.equal(rules.field_rules.phones['Primary Phone'].use, 'first valid');
  assert.equal(rules.field_rules.phones['Secondary Phone'].default, '');
  assert.deepEqual(rules.passenger_catalog.phone_migration.legacy_values, [OLD]);
  assert.equal(rules.passenger_catalog.migration_rules.length, 1);
  assert.deepEqual(rules.acceptance_tests.find((t) => t.id === 'AT-08').expected, { 'Primary Phone': NEW });
});

test('AT-63 no valid phone: new passenger gets 8584020500, catalog passenger keeps its phone', async () => {
  const cat = catalog([{ 'First Name': 'JOHN', 'Last Name': 'ROE', 'MRN Number': '2002', Telephone: '7605550199' }]);
  const r = await run([
    row({ Comments: 'CALL ON ARRIVAL' }),
    row({ 'Client ID': '2002', 'Client Name': 'ROE,JOHN', PUTime: '09:00' }),
  ], { catalog: cat });
  const byMrn = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'], d]));
  assert.equal(byMrn.NCTD1001['Primary Phone'], NEW);
  assert.equal(byMrn.NCTD1001['Secondary Phone'], '');
  assert.equal(byMrn.NCTD2002['Primary Phone'], '7605550199');
  assert.equal(r.catalog.rows.find((c) => c['MRN Number'] === 'NCTD1001').Telephone, NEW);
  assert.equal(has(r, OLD), false);
  // a real phone in Comments still wins over the fallback
  const withPhone = await run([row({ Comments: 'C: 760-555-0101' })]);
  assert.equal(withPhone.destinationRows[0]['Primary Phone'], '7605550101');
});

test('AT-64 catalog Telephone 9876543210 is changed to 8584020500; idempotent', async () => {
  const cat = catalog([
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: OLD },
    { 'First Name': 'JANE-PCA', 'Last Name': 'DOE', 'MRN Number': '1001PCA', Telephone: '987-654-3210' },
    { 'First Name': 'JOHN', 'Last Name': 'ROE', 'MRN Number': '2002', Telephone: '7605550199' },
  ]);
  const r = await run([row({ Comments: 'C: 760-555-0101' }), row({ 'Passenger Ty': 'PCA' })], { catalog: cat });
  assert.deepEqual(r.destinationRows.map((d) => d['Primary Phone']), [NEW, NEW]);
  assert.deepEqual(r.catalog.rows.map((c) => c.Telephone), [NEW, NEW, '7605550199']);
  assert.equal(r.summary.catalogPhonesMigrated, 2);
  assert.equal(r.summary.pasajerosAdded, 0);
  assert.equal(has(r, OLD), false);
  assert.ok(!r.exceptions.some((e) => e.code === 'CATALOG_PHONE_INVALID'));

  const again = await run([row()], { catalog: catalog(r.catalog.rows) });
  assert.equal(again.summary.catalogPhonesMigrated, 0);
  assert.deepEqual(again.catalog.rows, r.catalog.rows);
});
