'use strict';

// v2.12.0 ADDRESS-SUITE-002: AT-85 to AT-87.

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, row, run } = require('./helpers');

const addr = (d) => [d['Pickup Address'], d['Pickup Suite'], d['Dropoff Address'], d['Dropoff Suite']];

test('rules: v2.12.0 address secondary (kept in v2.13.0)', () => {
  assert.equal(rules.specification.version, '2.13.0');
  const a = rules.field_rules.address_secondary;
  assert.equal(a.rule_id, 'ADDRESS-SUITE-003');
  assert.equal(a.glued_indicator_spacing.enabled, true);
  assert.equal(a.standalone_trailing_unit.after_street_name_without_suffix.min_street_words, 2);
  assert.ok(rules.field_rules.pickup_address.secondary_indicators.includes('standalone trailing unit'), 'v1.4.0 indicators kept');
});

test('AT-85 trailing number after a street name in Spanish is the suite', async () => {
  const r = await run([
    row({ 'Client ID': '79766', 'Client Name': 'HAKALA,ALEKSI', PUAddress: '2245 CAMINO VIDA ROBLE  100', DOAddress: '422 CALLE CORAZON' }),
    row({ 'Client ID': '2', PUAddress: '444 N EL CAMINO REAL 81', PUTime: '09:00' }),
    row({ 'Client ID': '3', PUAddress: '3625 VISTA OCEANA 13', PUTime: '10:00' }),
  ]);
  const by = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'], addr(d)]));
  assert.deepEqual(by.NCTD79766, ['2245 CAMINO VIDA ROBLE', '100', '422 CALLE CORAZON', '']);
  assert.deepEqual(by.NCTD2.slice(0, 2), ['444 N EL CAMINO REAL', '81']);
  assert.deepEqual(by.NCTD3.slice(0, 2), ['3625 VISTA OCEANA', '13']);
});

test('AT-86 a unit glued to its indicator gets a space; others unchanged', async () => {
  const cases = [
    ['2245 CAMINO VIDA ROBLE UNIT100', '2245 CAMINO VIDA ROBLE', 'UNIT 100'],
    ['100 SANTA FE DR SUITE100', '100 SANTA FE DR', 'SUITE 100'],
    ['55 LAS FLORES DR SPC131', '55 LAS FLORES DR', 'SPC 131'],
    ['200 MISSION AVE STE5', '200 MISSION AVE', 'STE 5'],
    ['10 OAK ST APT4B', '10 OAK ST', 'APT 4B'],
    ['1475 RANCHEROS DR UNIT 196', '1475 RANCHEROS DR', 'UNIT 196'],
    ['10 OAK ST APT B', '10 OAK ST', 'APT B'],
    ['40 N BROADWAY #21', '40 N BROADWAY', '#21'],
    ['9 SYCAMORE AVE # 159', '9 SYCAMORE AVE', '# 159'],
  ];
  const r = await run(cases.map(([DOAddress], i) => row({ 'Client ID': String(10 + i), DOAddress, PUTime: `0${i}:15` })));
  const by = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'], [d['Dropoff Address'], d['Dropoff Suite']]]));
  cases.forEach(([, a, sfx], i) => assert.deepEqual(by[`NCTD${10 + i}`], [a, sfx], cases[i][0]));
});

test('AT-87 highway numbers and one-word streets stay whole', async () => {
  const cases = ['1200 STATE ROUTE 78', '500 OLD HIGHWAY 395', '77 OLD HWY 101', '100 MAIN 5', '2000 INTERSTATE 5'];
  const r = await run(cases.map((PUAddress, i) => row({ 'Client ID': String(20 + i), PUAddress, PUTime: `0${i}:30` })));
  const by = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'], [d['Pickup Address'], d['Pickup Suite']]]));
  cases.forEach((a, i) => assert.deepEqual(by[`NCTD${20 + i}`], [a, ''], a));
});
