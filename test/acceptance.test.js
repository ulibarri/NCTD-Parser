'use strict';

// Acceptance tests (acceptance_tests in config/rules, v2.0.0).

const test = require('node:test');
const assert = require('node:assert/strict');
const { row, returnOf, run, rules } = require('./helpers');
const { parseTripDate } = require('../src/parser/dates');
const { ProcessingError } = require('../src/parser/pipeline');
const { outputName } = require('../src/parser/csv-export');

const codes = (r) => r.exceptions.map((e) => e.code);

test('AT-01 single CLI single Leg: alphanumeric Vendor ID and Leg ID A', async () => {
  const r = await run([row()]);
  assert.equal(r.destinationRows.length, 1);
  const d = r.destinationRows[0];
  assert.equal(d['Vendor ID'], '1001202610230755');
  assert.equal(d['Leg ID'], '1001202610230755A');
  assert.equal(d['Pair Status'], 'Unpaired');
  assert.equal(d['Last Name'], 'DOE');
  assert.equal(d['First Name'], 'JANE');
  assert.equal(d['Pickup Time'], '2026-10-23 07:55:00.000');
  assert.equal(d['Dropoff Address'], '200 MISSION AVE');
  assert.equal(d['Dropoff Suite'], 'STE 5');
  assert.equal(d['Trip Purpose'], 'Dialysis');
  assert.ok(!('Journey ID' in d));
  assert.deepEqual(Object.keys(d), rules.destination_columns);
  assert.equal(r.summary.exportReady, true);
});

test('AT-02 CLI plus PCA same Leg: separate identifiers, companion names and MRN', async () => {
  const r = await run([row(), row({ 'Passenger Ty': 'PCA', Amount: '0' })]);
  const [cli, pca] = r.destinationRows;
  assert.equal(cli['Leg ID'], '1001202610230755A');
  assert.equal(pca['Vendor ID'], '1001202610230755PCA');
  assert.equal(pca['Leg ID'], '1001202610230755PCAA');
  assert.equal(pca['Tobi MRN'], '1001PCA');
  assert.equal(pca['First Name'], 'JANE-PCA'); // v2.7.0 NAME-003
  assert.equal(pca['Last Name'], 'DOE');
});

test('AT-03 reciprocal pair: earlier A, later B, Paired', async () => {
  const a = row();
  const r = await run([returnOf(a), a]);
  assert.deepEqual(r.destinationRows.map((d) => [d['Leg ID'], d['Pair Status']]), [
    ['1001202610230755A', 'Paired'], ['1001202610231500B', 'Paired'],
  ]);
});

test('AT-04 round trip with assistant: each paired separately', async () => {
  const a = row();
  const b = returnOf(a);
  const r = await run([a, row({ ...a, 'Passenger Ty': 'PCA' }), b, row({ ...b, 'Passenger Ty': 'PCA' })]);
  assert.deepEqual(r.destinationRows.map((d) => d['Leg ID']), [
    '1001202610230755A', '1001202610230755PCAA', '1001202610231500B', '1001202610231500PCAB',
  ]);
});

test('AT-05 two round trips on the same day are paired without ambiguity', async () => {
  const a = row();
  const r = await run([a, returnOf(a, { PUTime: '12:00' }), row({ PUTime: '15:00' }), returnOf(a, { PUTime: '18:00' })]);
  assert.equal(r.summary.exportReady, true);
  assert.deepEqual(r.destinationRows.map((d) => d['Leg ID']), [
    '1001202610230755A', '1001202610231200B', '1001202610231500A', '1001202610231800B',
  ]);
});

test('AT-06 exact duplicate: later copy removed only', async () => {
  const r = await run([row(), row()]);
  assert.equal(r.destinationRows.length, 1);
  assert.deepEqual(r.exceptions.find((e) => e.code === 'EXACT_DUPLICATE_REMOVED').rows, [3]);
});

test('AT-07 required field contains Empty -> Invalid Trips, export not blocked', async () => {
  const r = await run([row({ PUCity: 'Empty' }), row({ 'Client ID': '1002', PUTime: '08:00' })]);
  assert.equal(r.invalidRows.length, 1);
  assert.equal(r.invalidRows[0].PUCity, 'Empty');
  assert.equal(r.invalidRows[0]['Invalid Fields'], 'PUCity');
  assert.equal(r.destinationRows.length, 1);
  assert.equal(r.summary.exportReady, true);
});

test('AT-08 phones: from Comments, default 9876543210', async () => {
  let r = await run([row({ Comments: 'CALL ON ARRIVAL' })]);
  assert.equal(r.destinationRows[0]['Primary Phone'], '9876543210');
  r = await run([row({ Comments: 'C: 760-555-0101 H: (760) 555-0102' })]);
  assert.equal(r.destinationRows[0]['Primary Phone'], '7605550101');
  assert.equal(r.destinationRows[0]['Secondary Phone'], '7605550102');
});

test('AT-09 Booking Fare 0 for blank, zero, negative or invalid Amount', async () => {
  for (const Amount of ['', '0', '-3', 'abc']) {
    const r = await run([row({ Amount })]);
    assert.equal(r.destinationRows[0]['Booking Fare'], '0', `Amount=${Amount}`);
  }
});

test('AT-10 and AT-11 default Mode and Service Area', async () => {
  const r = await run([row()]);
  assert.equal(r.destinationRows[0].Mode, 'Ambulette');
  assert.equal(r.destinationRows[0]['Service Area'], 'NCTD Service Area');
});

test('AT-12 tags: CBLA and Visually Impaired, phrases from both versions, extra source columns', async () => {
  let r = await run([row({ Comments: 'VISUAL IMPAIRMENT. DO NOT LEAVE ALONE' })]);
  assert.equal(r.destinationRows[0]['Tobi Tags'], 'CBLA, Visually Impaired');
  r = await run([row({ Assisted: 'CBLA' })]);
  assert.equal(r.destinationRows[0]['Tobi Tags'], 'CBLA');
});

test('AT-13 companion reciprocal pair: PCAA and PCAB, letters and digits only', async () => {
  const a = row({ 'Passenger Ty': 'PCA' });
  const r = await run([a, returnOf(a)]);
  const ids = r.destinationRows.map((d) => d['Leg ID']);
  assert.deepEqual(ids, ['1001202610230755PCAA', '1001202610231500PCAB']);
  for (const d of r.destinationRows) {
    assert.match(d['Vendor ID'] + d['Leg ID'], /^[A-Za-z0-9]+$/);
    assert.equal(d['First Name'], 'JANE-PCA'); // NAME-003: visible -PCA only in First Name
  }
});

test('AT-14 and AT-15 date changed: dates and identifiers use the new date', async () => {
  const r = await run([row()], { overrideDate: parseTripDate('2026-11-12') });
  const d = r.destinationRows[0];
  assert.equal(d['Trip Date'], '2026-11-12 00:00:00.000');
  assert.equal(d['Pickup Time'], '2026-11-12 07:55:00.000');
  assert.equal(d['Dropoff Time'], '2026-11-12 09:30:00.000');
  assert.equal(d['Vendor ID'], '1001202611120755');
  assert.equal(d['Leg ID'], '1001202611120755A');
});

test('AT-16 date changed and an invalid TripDate: original values kept in Invalid Trips', async () => {
  const r = await run([row(), row({ 'Client ID': '1002', TripDate: '13/45/2026' })], { overrideDate: parseTripDate('2026-11-12') });
  assert.equal(r.invalidRows[0].TripDate, '13/45/2026');
  assert.match(r.invalidRows[0]['Validation Errors'], /MISSING_ID_COMPONENT/);
});

test('AT-17 more than one TripDate blocks the date change', async () => {
  await assert.rejects(
    run([row(), row({ 'Client ID': '1002', TripDate: '10/24/2026' })], { overrideDate: parseTripDate('2026-11-12') }),
    (err) => err instanceof ProcessingError && err.code === 'MULTIPLE_TRIP_DATES',
  );
});

test('unknown Passenger Ty -> Invalid Trips with UNKNOWN_PASSENGER_TYPE', async () => {
  const r = await run([row({ 'Passenger Ty': 'XYZ' })]);
  assert.ok(codes(r).includes('UNKNOWN_PASSENGER_TYPE'));
  assert.equal(r.invalidRows[0]['Validation Status'], 'EXCEPTION');
  assert.equal(r.summary.exportReady, true);
});

test('gate code kept in Pickup Gate Code without #', async () => {
  const r = await run([row({ Comments: 'GATE CODE #7444', 'Space Type': 'LR' })]);
  assert.equal(r.destinationRows[0]['Pickup Gate Code'], '7444');
  assert.equal(r.destinationRows[0]['Booking Notes'], 'GATE CODE #7444, Lift Required');
});

// ---- output_file_naming (v1.4.0, kept) ----
const naming = rules.file_contract.output_file_naming;
const changed = { originalDate: parseTripDate('2026-10-23'), newDate: parseTripDate('2026-11-12') };

test('AT-18 date changed: new date replaces the original one in Output and Invalid Trips names', () => {
  assert.equal(outputName('NCTD_Trips_10.23.26_1.xlsx', 'destination', naming, changed), 'NCTD_Trips_11.12.26_1_TOBI.csv');
  assert.equal(outputName('NCTD_Trips_10.23.26_1.xlsx', 'invalid_trips', naming, changed), 'NCTD_Trips_11.12.26_1_INVALID_TRIPS.csv');
  assert.equal(outputName('Pasajeros.csv', 'pasajeros_updated', naming, changed, new Date('2026-11-10T23:55:00Z')), 'NCTD_Passengers_20261110_UPDTD.csv');
});

test('AT-19 date changed and the name has no original date: new date is appended', () => {
  assert.equal(outputName('Manifest.xlsx', 'destination', naming, changed), 'Manifest_11.12.26_TOBI.csv');
});

test('AT-20 date not changed: names keep the Source base name', () => {
  assert.equal(outputName('NCTD_Trips_10.23.26_1.xlsx', 'destination', naming), 'NCTD_Trips_10.23.26_1_TOBI.csv');
});

test('blocking: collisions block the export and count each source row once', async () => {
  const r = await run([row(), row({ Comments: 'different note' }), row({ 'Client ID': '1002', PUTime: '09:00' })]);
  assert.equal(r.summary.exportReady, false);
  assert.equal(r.summary.blockingErrors, 2);
});

test('AT-28 updated Pasajeros name is fixed, with the processing date', () => {
  const now = new Date('2026-11-10T23:55:00Z'); // 17:55 in Mexico City
  assert.equal(outputName('NCTD_Passengers.csv', 'pasajeros_updated', naming, {}, now), 'NCTD_Passengers_20261110_UPDTD.csv');
  assert.equal(outputName('NCTD_Passengers_20261109_UPDTD.csv', 'pasajeros_updated', naming, {}, now), 'NCTD_Passengers_20261110_UPDTD.csv');
  assert.equal(outputName(null, 'pasajeros_updated', naming, {}, now), 'NCTD_Passengers_20261110_UPDTD.csv');
});

test('AT-29 the date follows America/Mexico_City, not UTC', () => {
  assert.equal(outputName(null, 'pasajeros_updated', naming, {}, new Date('2026-11-11T00:30:00Z')), 'NCTD_Passengers_20261110_UPDTD.csv');
  assert.equal(outputName(null, 'pasajeros_updated', naming, {}, new Date('2026-11-11T06:30:00Z')), 'NCTD_Passengers_20261111_UPDTD.csv');
});

test('AT-30 every CSV output uses the lowercase .csv extension', () => {
  for (const kind of ['destination', 'invalid_trips', 'pasajeros_updated']) {
    assert.match(outputName('NCTD_Trips_10.23.26_1.xlsx', kind, naming), /\.csv$/);
  }
});

const nameCase = async (name, type = 'CLI') => {
  const r = await run([row(), row({ 'Client Name': name, 'Client ID': '2002', 'Passenger Ty': type, PUTime: '09:00:00' })]);
  return r;
};
const assertBadName = (r) => {
  assert.equal(r.destinationRows.length, 1);
  assert.equal(r.invalidRows.length, 1);
  assert.equal(r.invalidRows[0]['Invalid Fields'], 'Client Name');
  assert.match(r.invalidRows[0]['Validation Errors'], /INVALID_CLIENT_NAME_FORMAT/);
  assert.ok(r.exceptions.some((e) => e.code === 'INVALID_CLIENT_NAME_FORMAT' && e.severity === 'error'));
  assert.equal(r.summary.exportReady, true);
  assert.ok(!r.destinationRows.some((d) => d['Tobi MRN'].startsWith('2002')));
};

test('AT-34 Client Name without a comma -> Invalid Trips, export not blocked', async () => {
  assertBadName(await nameCase('ALLOUCHE DEANNE'));
  assertBadName(await nameCase('ALLOUCHE DEANNE - PCA', 'PCA'));
});

test('AT-35 Client Name with an empty part -> Invalid Trips', async () => {
  assertBadName(await nameCase('ALLOUCHE,'));
  assertBadName(await nameCase(' , DEANNE'));
  assertBadName(await nameCase('ALLOUCHE,- PCA', 'PCA'));
  const ok = await nameCase('ALLOUCHE , DEANNE');
  assert.equal(ok.invalidRows.length, 0);
  assert.equal(ok.destinationRows.length, 2);
});

test('AT-36 brackets removed from Client Name, enclosed text kept', async () => {
  const r = await run([row({ 'Client Name': 'MATTHEWS,SCOTT  (MICHAEL)' })]);
  assert.equal(r.destinationRows[0]['Last Name'], 'MATTHEWS');
  assert.equal(r.destinationRows[0]['First Name'], 'SCOTT MICHAEL');
  assert.deepEqual(r.catalog.rows.map((c) => c['First Name']), ['SCOTT MICHAEL']);
  const pca = await run([row({ 'Client Name': '[DOE],(JANE) - PCA', 'Passenger Ty': 'PCA' })]);
  assert.equal(pca.destinationRows[0]['First Name'], 'JANE-PCA');
  assert.equal(pca.destinationRows[0]['Last Name'], 'DOE');
});

test('AT-37 brackets removed from address, city and ZIP before validation', async () => {
  const r = await run([row({ PUAddress: '100 MAIN ST [REAR]', PUCity: '(OCEANSIDE)', PUZipcode: '(92054)', DOAddress: '200 MISSION AVE (STE 5)', DOCity: '[VISTA]', DOZipcode: '[92081]' })]);
  assert.equal(r.invalidRows.length, 0);
  const d = r.destinationRows[0];
  assert.equal(d['Pickup Address'], '100 MAIN ST REAR');
  assert.equal(d['Pickup City'], 'OCEANSIDE');
  assert.equal(d['Pickup Zip'], '92054');
  assert.equal(d['Dropoff Address'], '200 MISSION AVE');
  assert.equal(d['Dropoff Suite'], 'STE 5');
  assert.equal(d['Dropoff City'], 'VISTA');
  assert.equal(d['Dropoff Zip'], '92081');
  // pairing still works with brackets on one leg only
  const a = row({ PUAddress: '100 MAIN ST (REAR)' });
  const p = await run([a, returnOf(row({ PUAddress: '100 MAIN ST REAR' }))]);
  assert.deepEqual(p.destinationRows.map((x) => x['Pair Status']), ['Paired', 'Paired']);
});

test('AT-38 invalid row keeps its original values, brackets included', async () => {
  const r = await run([row({ 'Client Name': 'MATTHEWS,SCOTT  (MICHAEL)', PUCity: '()' })]);
  assert.equal(r.invalidRows.length, 1);
  assert.equal(r.invalidRows[0]['Client Name'], 'MATTHEWS,SCOTT  (MICHAEL)');
  assert.equal(r.invalidRows[0].PUCity, '()');
  assert.match(r.invalidRows[0]['Validation Errors'], /PUCity: missing value/);
});
