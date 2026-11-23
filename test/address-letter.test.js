'use strict';

// v2.13.0 ADDRESS-SUITE-003: AT-88 to AT-90 (trailing letter unit).

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, row, run } = require('./helpers');
const { splitAddress } = require('../src/parser/fields');

const IND = rules.field_rules.pickup_address.secondary_indicators;
const OPT = rules.field_rules.address_secondary;

test('rules: v2.13.0 trailing letter unit', () => {
  const t = rules.field_rules.address_secondary.standalone_trailing_unit.trailing_letter;
  assert.equal(t.enabled, true);
  assert.deepEqual(t.letters_not_split, ['N', 'S', 'E', 'W']);
  // v2.12.0 settings kept by the deep merge
  assert.equal(OPT.glued_indicator_spacing.enabled, true);
  assert.equal(OPT.standalone_trailing_unit.after_street_name_without_suffix.min_street_words, 2);
});

test('AT-88 a single trailing letter is the suite (CFS 11.23.26)', async () => {
  const r = await run([
    row({ 'Client ID': '758', PUAddress: '3214 MISSION AVE 122', DOAddress: '3300 VISTA WAY A', PUTime: '12:20' }),
    row({ 'Client ID': '85099', PUAddress: '183 CALLE MAGDALENA', DOAddress: '1622 BROADWAY A', PUTime: '16:00' }),
    row({ 'Client ID': '85631', PUAddress: '1259 NATOMA WAY C', DOAddress: '335 SAXONY RD', PUTime: '08:00' }),
  ]);
  const by = Object.fromEntries(r.destinationRows.map((d) => [d['Tobi MRN'],
    [d['Pickup Address'], d['Pickup Suite'], d['Dropoff Address'], d['Dropoff Suite']]]));
  assert.deepEqual(by.NCTD758, ['3214 MISSION AVE', '122', '3300 VISTA WAY', 'A']);
  assert.deepEqual(by.NCTD85099, ['183 CALLE MAGDALENA', '', '1622 BROADWAY', 'A']);
  assert.deepEqual(by.NCTD85631, ['1259 NATOMA WAY', 'C', '335 SAXONY RD', '']);
  for (const [a, st, su] of [['326 S EL CAMINO REAL C', '326 S EL CAMINO REAL', 'C'], ['1009 CHINQUAPIN AVE D', '1009 CHINQUAPIN AVE', 'D'],
    ['564 BIG BEND WAY C', '564 BIG BEND WAY', 'C'], ['1216 PALOMAR PL B', '1216 PALOMAR PL', 'B']]) {
    assert.deepEqual(splitAddress(a, IND, OPT), { street: st, suite: su }, a);
  }
});

test('AT-89 post-directionals N, S, E and W stay in the street', () => {
  for (const a of ['2732 LOKER AVE W', '184 TERRACE DR E', '16127 VIA MADERA CIRCA W', '500 MAIN ST N', '9 OCEAN BLVD S']) {
    assert.deepEqual(splitAddress(a, IND, OPT), { street: a, suite: '' }, a);
  }
});

test('AT-90 letter street names, highways and no house number stay whole; indicators unchanged', () => {
  for (const a of ['100 AVENUE C', '20 N AVE D', '77 OLD HWY A', 'BROADWAY A', '5 PO BOX A']) {
    assert.deepEqual(splitAddress(a, IND, OPT), { street: a, suite: '' }, a);
  }
  assert.deepEqual(splitAddress('10 OAK ST APT B', IND, OPT), { street: '10 OAK ST', suite: 'APT B' });
  assert.deepEqual(splitAddress('40 N BROADWAY #B', IND, OPT), { street: '40 N BROADWAY', suite: '#B' });
  // without the options (v1.4.0 behavior) the letter stays
  assert.deepEqual(splitAddress('1622 BROADWAY A', IND), { street: '1622 BROADWAY A', suite: '' });
});
