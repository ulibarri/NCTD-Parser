'use strict';

// Acceptance tests AT-01 to AT-17 from config/rules (v1.3.0).

const test = require('node:test');
const assert = require('node:assert/strict');
const { row, returnOf, run, tempRegistry } = require('./helpers');
const { parseTripDate } = require('../src/parser/dates');
const { ProcessingError } = require('../src/parser/pipeline');

const codes = (r) => r.exceptions.map((e) => e.code);

test('AT-01 single CLI single Leg', async () => {
  const r = await run([row()]);
  assert.equal(r.destinationRows.length, 1);
  const d = r.destinationRows[0];
  assert.equal(d['Journey ID'], '2610230001');
  assert.equal(d['Leg ID'], '1001_2610230001_A');
  assert.equal(d['Last Name'], 'DOE');
  assert.equal(d['First Name'], 'JANE');
  assert.equal(d['Middle Name'], '');
  assert.equal(d['Pickup Time'], '2026-10-23 07:55:00.000');
  assert.equal(d['Dropoff Time'], '2026-10-23 09:30:00.000');
  assert.equal(d['Dropoff Address'], '200 MISSION AVE');
  assert.equal(d['Dropoff Suite'], 'STE 5');
  assert.equal(d['Trip Purpose'], 'Dialysis');
  assert.equal(d['Pickup State'], 'CA');
});

test('AT-02 CLI plus PCA same Leg share IDs; PCA MRN ends _PCA', async () => {
  const r = await run([row(), row({ 'Passenger Ty': 'PCA', Amount: '0' })]);
  assert.equal(r.destinationRows.length, 2);
  const [cli, pca] = r.destinationRows;
  assert.equal(cli['Leg ID'], pca['Leg ID']);
  assert.equal(cli['Journey ID'], pca['Journey ID']);
  assert.equal(pca['Tobi MRN'], '1001_PCA');
  assert.equal(pca['First Name'], 'JANE - PCA');
  assert.equal(cli['Tobi MRN'], '1001');
});

test('COM and COMP get " - PCA" in the name but no _PCA in the MRN', async () => {
  const r = await run([row(), row({ 'Passenger Ty': 'COMP' })]);
  assert.equal(r.destinationRows[1]['First Name'], 'JANE - PCA');
  assert.equal(r.destinationRows[1]['Tobi MRN'], '1001');
});

test('AT-03 reciprocal two-Leg Journey: earlier A, later B, one Journey ID', async () => {
  const a = row();
  const r = await run([returnOf(a), a]);
  const ids = r.destinationRows.map((d) => d['Leg ID']);
  assert.deepEqual(ids, ['1001_2610230001_A', '1001_2610230001_B']);
  assert.equal(r.destinationRows[0]['Pickup Time'], '2026-10-23 07:55:00.000');
  assert.equal(r.summary.journeys, 1);
});

test('AT-04 round trip with assistant shares identifiers on each Leg', async () => {
  const a = row();
  const b = returnOf(a);
  const r = await run([a, row({ ...a, 'Passenger Ty': 'PCA' }), b, row({ ...b, 'Passenger Ty': 'PCA' })]);
  const legs = r.destinationRows.map((d) => [d['Tobi MRN'], d['Leg ID']]);
  assert.deepEqual(legs, [
    ['1001', '1001_2610230001_A'], ['1001_PCA', '1001_2610230001_A'],
    ['1001', '1001_2610230001_B'], ['1001_PCA', '1001_2610230001_B'],
  ]);
});

test('AT-05 orphan assistant -> ASSISTANT_WITHOUT_CLIENT', async () => {
  const r = await run([row({ 'Passenger Ty': 'PCA' })]);
  assert.ok(codes(r).includes('ASSISTANT_WITHOUT_CLIENT'));
  assert.equal(r.destinationRows.length, 0);
  assert.equal(r.invalidRows[0]['Validation Status'], 'EXCEPTION');
});

test('AT-06 exact duplicate: later copy removed only', async () => {
  const r = await run([row(), row()]);
  assert.equal(r.destinationRows.length, 1);
  assert.equal(r.summary.duplicatesRemoved, 1);
  assert.deepEqual(r.exceptions.find((e) => e.code === 'EXACT_DUPLICATE_REMOVED').rows, [3]);
});

test('AT-07 required field contains Empty -> Invalid Trips, no IDs', async () => {
  const r = await run([row({ PUCity: 'Empty' }), row({ 'Client ID': '1002', PUTime: '08:00' })]);
  assert.equal(r.invalidRows.length, 1);
  const inv = r.invalidRows[0];
  assert.equal(inv.PUCity, 'Empty');
  assert.equal(inv['Validation Status'], 'INVALID');
  assert.equal(inv['Invalid Fields'], 'PUCity');
  assert.equal(inv['Source Row Number'], '2');
  // the invalid row consumed no sequence: the valid row gets 0001
  assert.equal(r.destinationRows[0]['Journey ID'], '2610230001');
});

test('AT-08 no valid phone -> Primary Phone 9876543210; phones read from Comments', async () => {
  let r = await run([row({ Comments: 'CALL ON ARRIVAL' })]);
  assert.equal(r.destinationRows[0]['Primary Phone'], '9876543210');
  assert.equal(r.destinationRows[0]['Secondary Phone'], '');
  r = await run([row({ Comments: 'C: 760-555-0101 H: (760) 555-0102 W: +1 760 555 0103' })]);
  assert.equal(r.destinationRows[0]['Primary Phone'], '7605550101');
  assert.equal(r.destinationRows[0]['Secondary Phone'], '7605550102');
});

test('AT-09 Amount blank, zero, negative or invalid -> Booking Fare 0', async () => {
  for (const Amount of ['', '0', '-3', 'abc']) {
    const r = await run([row({ Amount })]);
    assert.equal(r.destinationRows[0]['Booking Fare'], '0', `Amount=${Amount}`);
  }
  const r = await run([row({ Amount: '$5.50' })]);
  assert.equal(r.destinationRows[0]['Booking Fare'], '5.5');
});

test('AT-10 and AT-11 default Mode and Service Area', async () => {
  const r = await run([row()]);
  assert.equal(r.destinationRows[0].Mode, 'Ambulette');
  assert.equal(r.destinationRows[0]['Service Area'], 'NCTD Service Area');
});

test('AT-12 VISIUALLY IMPAIRED -> Tobi Tags "Visually Impaired"; tags deduplicated', async () => {
  const r = await run([row({ Comments: 'VISIUALLY IMPAIRED, LEGALLY BLIND. DO NOT LEAVE ALONE' })]);
  assert.equal(r.destinationRows[0]['Tobi Tags'], 'CBLA, Visually Impaired');
});

test('AT-13 reprocessing within retention reuses Journey ID without consuming sequence', async () => {
  const registry = tempRegistry();
  const first = await run([row()], { registry });
  const second = await run([row()], { registry });
  assert.equal(second.destinationRows[0]['Journey ID'], first.destinationRows[0]['Journey ID']);
  assert.equal(second.summary.journeysReused, 1);
  const third = await run([row({ 'Client ID': '1002' })], { registry });
  assert.equal(third.destinationRows[0]['Journey ID'], '2610230002');
  // after 72 hours the mapping expires and a new ID is generated
  const later = await run([row()], { registry, now: new Date(Date.now() + 73 * 3600 * 1000) });
  assert.equal(later.destinationRows[0]['Journey ID'], '2610230003');
});

test('AT-14 date changed: Trip Date, Pickup Time and Dropoff Time use the new date', async () => {
  const r = await run([row()], { overrideDate: parseTripDate('2026-11-12') });
  const d = r.destinationRows[0];
  assert.equal(d['Trip Date'], '2026-11-12 00:00:00.000');
  assert.equal(d['Pickup Time'], '2026-11-12 07:55:00.000');
  assert.equal(d['Dropoff Time'], '2026-11-12 09:30:00.000');
});

test('AT-15 date changed: Journey ID starts with 261112 and Leg IDs embed it', async () => {
  const a = row();
  const r = await run([a, returnOf(a)], { overrideDate: parseTripDate('2026-11-12') });
  assert.deepEqual(r.destinationRows.map((d) => d['Leg ID']), ['1001_2611120001_A', '1001_2611120001_B']);
});

test('AT-16 date changed and a row has an invalid TripDate: original values kept, no IDs', async () => {
  const r = await run([row(), row({ 'Client ID': '1002', TripDate: '13/45/2026' })], { overrideDate: parseTripDate('2026-11-12') });
  assert.equal(r.destinationRows.length, 1);
  assert.equal(r.invalidRows[0].TripDate, '13/45/2026');
  assert.equal(r.invalidRows[0]['Invalid Fields'], 'TripDate');
});

test('AT-17 more than one TripDate blocks the date change (MULTIPLE_TRIP_DATES)', async () => {
  await assert.rejects(
    run([row(), row({ 'Client ID': '1002', TripDate: '10/24/2026' })], { overrideDate: parseTripDate('2026-11-12') }),
    (err) => err instanceof ProcessingError && err.code === 'MULTIPLE_TRIP_DATES',
  );
});

test('Dropoff Time is empty when DOAppt is empty; row stays valid', async () => {
  const r = await run([row({ DOAppt: '' })]);
  assert.equal(r.destinationRows[0]['Dropoff Time'], '');
});

test('non-reciprocal second leg -> NONRECIPROCAL_ROUTE warning, two single-leg journeys', async () => {
  const r = await run([row(), row({ PUTime: '15:00', PUAddress: '9 OTHER RD' })]);
  assert.ok(codes(r).includes('NONRECIPROCAL_ROUTE'));
  assert.deepEqual(r.destinationRows.map((d) => d['Leg ID']), ['1001_2610230001_A', '1001_2610230002_A']);
});

test('two possible return legs -> MULTIPLE_RETURN_LEGS', async () => {
  const a = row();
  const r = await run([a, returnOf(a), returnOf(a, { PUTime: '16:00' })]);
  assert.ok(codes(r).includes('MULTIPLE_RETURN_LEGS'));
  assert.equal(r.destinationRows.length, 0);
});

test('two clients on the same leg -> MULTIPLE_CLIENTS_SAME_LEG', async () => {
  const r = await run([row(), row({ 'Client Name': 'ROE ,RICHARD' })]);
  assert.ok(codes(r).includes('MULTIPLE_CLIENTS_SAME_LEG'));
  assert.equal(r.invalidRows.length, 2);
});

test('unknown Passenger Ty -> UNKNOWN_PASSENGER_TYPE', async () => {
  const r = await run([row({ 'Passenger Ty': 'XYZ' })]);
  assert.ok(codes(r).includes('UNKNOWN_PASSENGER_TYPE'));
});

test('Space Type mapping, LR booking note and unknown code default', async () => {
  const r = await run([
    row({ 'Space Type': 'LR', Comments: 'GATE CODE #7444' }),
    row({ 'Client ID': '2', 'Space Type': 'XW', PUTime: '08:00' }),
    row({ 'Client ID': '3', 'Space Type': '1', PUTime: '08:05' }),
  ]);
  const [lr, xw, unknown] = r.destinationRows;
  assert.equal(lr['Seating Need'], 'Ambulatory');
  assert.equal(lr['Booking Notes'], 'GATE CODE #7444, Lift Required');
  assert.equal(lr['Pickup Gate Code'], '7444');
  assert.equal(xw['Service Type'], 'Bariatric Wheelchair');
  assert.equal(unknown['Seating Need'], 'Ambulatory');
  assert.deepEqual(r.summary.unknownSpaceTypes, ['1']);
});

test('Trip Purpose matches keywords inside location names; pickup first', async () => {
  const r = await run([
    row({ PickUpLocationName: 'ALZHEIMERS-GLENNER SAXONY', DropLocationName: 'DIALYSIS - X' }),
    row({ 'Client ID': '2', PUTime: '08:00', PickUpLocationName: '', DropLocationName: 'LIFE OF LIBERTY - HORNE ST' }),
    row({ 'Client ID': '3', PUTime: '08:05', PickUpLocationName: '', DropLocationName: 'TARGET' }),
  ]);
  assert.deepEqual(r.destinationRows.map((d) => d['Trip Purpose']), ['Glenner', 'Day Center', 'Appointment']);
  assert.equal(r.destinationRows[0]['Leg Notes'], 'PULN: ALZHEIMERS-GLENNER SAXONY | DOLN: DIALYSIS - X');
  assert.equal(r.destinationRows[2]['Leg Notes'], 'DOLN: TARGET');
});
