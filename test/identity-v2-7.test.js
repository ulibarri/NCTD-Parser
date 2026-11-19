'use strict';

// v2.7.0: PASSENGER-IDENTITY-002, NAME-003, IDENTIFIER-SUFFIX-002,
// PAIRING-001-OVERRIDE-002 and FARE-002-PRESERVE (AT-45 to AT-52).

const test = require('node:test');
const assert = require('node:assert/strict');
const { row, returnOf, run } = require('./helpers');

const lopez = (type, extra = {}) => row({ 'Client Name': 'LOPEZ,MARIA', 'Client ID': '3333', 'Passenger Ty': type, ...extra });
const pick = (d) => ({ 'Last Name': d['Last Name'], 'First Name': d['First Name'], 'Tobi MRN': d['Tobi MRN'] });
const ALNUM = /^[A-Za-z0-9]+$/;

test('AT-45 PCA: First Name -PCA, Last Name unchanged, MRN 3333PCA', async () => {
  const r = await run([lopez('PCA')]);
  assert.deepEqual(pick(r.destinationRows[0]), { 'Last Name': 'LOPEZ', 'First Name': 'MARIA-PCA', 'Tobi MRN': 'NCTD3333PCA' });
});

test('AT-46 COM: First Name -COM, MRN 3333COM', async () => {
  const r = await run([lopez('COM')]);
  assert.deepEqual(pick(r.destinationRows[0]), { 'Last Name': 'LOPEZ', 'First Name': 'MARIA-COM', 'Tobi MRN': 'NCTD3333COM' });
});

test('AT-47 COMP canonicalizes to COM', async () => {
  const r = await run([lopez('COMP')]);
  assert.deepEqual(pick(r.destinationRows[0]), { 'Last Name': 'LOPEZ', 'First Name': 'MARIA-COM', 'Tobi MRN': 'NCTD3333COM' });
  assert.equal(r.destinationRows[0]['Vendor ID'], '3333202610230755COM');
});

for (const [id, type, sfx] of [['AT-48', 'PCA', 'PCA'], ['AT-49', 'COM', 'COM']]) {
  test(`${id} ${type} technical IDs are alphanumeric with ${sfx}`, async () => {
    const a = lopez(type, { 'Client ID': '33-33' });
    const r = await run([a, returnOf(a)]);
    for (const d of r.destinationRows) {
      for (const c of ['Tobi MRN', 'Vendor ID', 'Leg ID', 'Leg ID V2']) assert.match(d[c], ALNUM, `${c} ${d[c]}`);
    }
    assert.deepEqual(r.destinationRows.map((d) => d['Leg ID']), [`3333202610230755${sfx}A`, `3333202610231500${sfx}B`]);
    assert.equal(r.destinationRows[0]['Tobi MRN'], `NCTD3333${sfx}`);
    // reprocessing an ID that already carries the suffix does not duplicate it
    const again = await run([lopez(type, { 'Client ID': `3333${sfx}` })]);
    assert.equal(again.destinationRows[0]['Tobi MRN'], `NCTD3333${sfx}`);
  });
}

test('AT-50 PCA and COM of the same client and time do not collide', async () => {
  const r = await run([lopez('CLI'), lopez('PCA'), lopez('COM')]);
  assert.equal(r.destinationRows.length, 3);
  for (const c of ['Tobi MRN', 'Vendor ID', 'Leg ID', 'Leg ID V2']) {
    assert.equal(new Set(r.destinationRows.map((d) => d[c])).size, 3, c);
  }
  assert.ok(!r.exceptions.some((e) => /COLLISION/.test(e.code)));
  assert.ok(r.summary.exportReady);
});

test('AT-51 a PCA leg never pairs with a COM/COMP leg', async () => {
  const out = lopez('PCA');
  const back = returnOf(lopez('COMP'));
  const r = await run([out, back]);
  assert.deepEqual(r.destinationRows.map((d) => [d['Tobi MRN'], d['Pair Status'], d['Leg ID']]), [
    ['NCTD3333PCA', 'Unpaired', '3333202610230755PCAA'],
    ['NCTD3333COM', 'Unpaired', '3333202610231500COMA'],
  ]);
  // same class still pairs
  const ok = await run([lopez('COM'), returnOf(lopez('COMP'))]);
  assert.deepEqual(ok.destinationRows.map((d) => d['Pair Status']), ['Paired', 'Paired']);
});

test('AT-52 Booking Fare comes from Amount, not from the passenger type', async () => {
  const r = await run([
    lopez('PCA', { Amount: '$4.50' }),
    lopez('COM', { Amount: '0', PUTime: '09:00:00' }),
    lopez('COMP', { Amount: '', PUTime: '10:00:00' }),
    lopez('CLI', { Amount: '-3', PUTime: '11:00:00' }),
  ]);
  const fare = Object.fromEntries(r.destinationRows.map((d) => [d['Vendor ID'], d['Booking Fare']]));
  assert.deepEqual(fare, {
    '3333202610230755PCA': '4.5',
    '3333202610230900COM': '0',
    '3333202610231000COM': '0',
    '3333202610231100': '0',
  });
});
