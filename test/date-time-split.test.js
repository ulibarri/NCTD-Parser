'use strict';

// v2.10.0 DATE-TIME-SPLIT-001: AT-76 to AT-79.

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, row, run } = require('./helpers');
const { parseTripDate, formatWith } = require('../src/parser/dates');
const { toCsv } = require('../src/parser/csv-export');

const NEW = ['Pickup Time Only', 'Pickup Date Only', 'Dropoff Time Only', 'Dropoff Date Only'];
const only = (d) => Object.fromEntries(NEW.map((c) => [c, d[c]]));

test('rules: v2.10.0 split date and time columns', () => {
  assert.equal(rules.specification.version, '2.10.0');
  const s = rules.field_rules.dates_and_times.split_columns;
  assert.equal(s.rule_id, 'DATE-TIME-SPLIT-001');
  assert.deepEqual(NEW.map((c) => s[c].format), ['HH:mm', 'MM/DD/YYYY', 'HH:mm', 'MM/DD/YYYY']);
  assert.equal(rules.field_rules.dates_and_times.format, 'YYYY-MM-DD HH:mm:ss.SSS', 'existing columns keep their format');
  assert.ok(rules.trip_date_override.affected_destination_fields['Pickup Time'], 'v1.4 entries kept by the deep merge');
  assert.ok(rules.trip_date_override.affected_destination_fields['Pickup Date Only']);
});

test('AT-76 Pickup Time Only is HH:mm, military time without seconds', async () => {
  const r = await run([
    row({ 'Client ID': '1', PUTime: '7:25' }),
    row({ 'Client ID': '2', PUTime: '07:25:00' }),
    row({ 'Client ID': '3', PUTime: '14:00' }),
    row({ 'Client ID': '4', PUTime: String(14 / 24) }), // Excel time fraction
    row({ 'Client ID': '5', PUTime: '0:05:09' }),
    row({ 'Client ID': '6', PUTime: '12:00:30' }),
  ]);
  const by = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'], d['Pickup Time Only']]));
  assert.deepEqual(by, { 1: '07:25', 2: '07:25', 3: '14:00', 4: '14:00', 5: '00:05', 6: '12:00' });
});

test('AT-77 Pickup Date Only is MM/DD/YYYY and follows a trip date change', async () => {
  for (const TripDate of ['12/24/2026', '2026-12-24', '12/24/26', '46380']) {
    const r = await run([row({ TripDate })]);
    assert.equal(r.destinationRows[0]['Pickup Date Only'], '12/24/2026', TripDate);
  }
  const changed = await run([row({ TripDate: '12/24/2026' })], { overrideDate: parseTripDate('2027-01-05') });
  assert.deepEqual(only(changed.destinationRows[0]), {
    'Pickup Time Only': '07:55', 'Pickup Date Only': '01/05/2027', 'Dropoff Time Only': '09:30', 'Dropoff Date Only': '01/05/2027',
  });
  assert.equal(changed.destinationRows[0]['Trip Date'], '2027-01-05 00:00:00.000');
});

test('AT-78 Dropoff columns: filled from DOAppt, empty when DOAppt is empty', async () => {
  const r = await run([
    row({ 'Client ID': '1', TripDate: '12/24/2026', PUTime: '07:30', DOAppt: '09:00' }),
    row({ 'Client ID': '2', TripDate: '12/24/2026', PUTime: '12:00', DOAppt: '' }),
  ]);
  const by = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'], only(d)]));
  assert.deepEqual(by['1'], { 'Pickup Time Only': '07:30', 'Pickup Date Only': '12/24/2026', 'Dropoff Time Only': '09:00', 'Dropoff Date Only': '12/24/2026' });
  assert.deepEqual(by['2'], { 'Pickup Time Only': '12:00', 'Pickup Date Only': '12/24/2026', 'Dropoff Time Only': '', 'Dropoff Date Only': '' });
  assert.equal(r.destinationRows.find((d) => d['Tobi MRN'] === '2')['Dropoff Time'], '');
});

test('AT-79 37 columns, the new ones right after Dropoff Time, existing columns unchanged', async () => {
  const r = await run([row({ TripDate: '12/24/2026', PUTime: '07:25', DOAppt: '14:00' })]);
  assert.equal(r.destinationColumns.length, 37);
  const i = r.destinationColumns.indexOf('Dropoff Time');
  assert.deepEqual(r.destinationColumns.slice(i - 2, i + 6), ['Trip Date', 'Pickup Time', 'Dropoff Time', ...NEW, 'Mode']);
  const d = r.destinationRows[0];
  assert.equal(d['Trip Date'], '2026-12-24 00:00:00.000');
  assert.equal(d['Pickup Time'], '2026-12-24 07:25:00.000');
  assert.equal(d['Dropoff Time'], '2026-12-24 14:00:00.000');
  const csv = toCsv(r.destinationColumns, r.destinationRows).split(/\r?\n/);
  assert.match(csv[0], /,Dropoff Time,Pickup Time Only,Pickup Date Only,Dropoff Time Only,Dropoff Date Only,Mode,/);
  assert.match(csv[1], /,2026-12-24 14:00:00\.000,07:25,12\/24\/2026,14:00,12\/24\/2026,/);
});

test('formatWith tokens', () => {
  assert.equal(formatWith('MM/DD/YYYY', { y: 2026, m: 1, d: 5 }), '01/05/2026');
  assert.equal(formatWith('HH:mm:ss', null, { h: 7, mi: 5, s: 0 }), '07:05:00');
  assert.throws(() => formatWith('HH:mm', { y: 2026, m: 1, d: 5 }), /no value for HH/);
});
