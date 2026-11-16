'use strict';

// v2.8.1: CLIENT-NAME-NICKNAME-001 (AT-59 to AT-62) and the reduced scope of SOURCE-SPECIAL-CHARS-001.

const test = require('node:test');
const assert = require('node:assert/strict');
const { rules, row, run } = require('./helpers');

const one = async (name, extra = {}) => (await run([row({ 'Client Name': name, ...extra })])).destinationRows[0];

test('rules: v2.8.1 nickname rule (active since v2.8.1), character cleanup no longer on Client Name, CBLA kept', () => {
  assert.ok(rules.specification.changelog.some((c) => c.version === '2.8.1'));
  assert.ok(!rules.normalization.source_character_cleanup.columns.includes('Client Name'));
  assert.equal(rules.field_rules.client_name.nickname_removal.rule_id, 'CLIENT-NAME-NICKNAME-001');
  assert.deepEqual(rules.field_rules.tobi_tags.rules[0].phrases.sort(),
    ['CAN NOT BE LEFT ALONE', 'CANNOT BE LEFT ALONE', 'CBLA', 'DO NOT LEAVE ALONE', 'DO NOT LEAVE UNATTENDED']);
});

test('AT-59 nickname between [ ], double quotes or curly quotes', async () => {
  for (const [name, nick] of [['DOE,JANE [JJ]', 'JJ'], ['DOE,JANE "JJ"', 'JJ'], ['DOE,JANE “JJ”', 'JJ'], ['DOE (JD),JANE', 'JD']]) {
    const d = await one(name);
    assert.deepEqual([d['Last Name'], d['First Name'], d['Booking Notes']], ['DOE', 'JANE', `Nickname: ${nick}`], name);
  }
  const two = await one('LEE (BOB),ROBERT “ROB”');
  assert.deepEqual([two['Last Name'], two['First Name'], two['Booking Notes']], ['LEE', 'ROBERT', 'Nickname: BOB / ROB']);
});

test('AT-60 the nickname is appended after the other Booking Notes', async () => {
  const d = await one('MATTHEWS,SCOTT  (MICHAEL)', { Comments: 'CALL ON ARRIVAL', 'Space Type': 'LR' });
  assert.equal(d['Booking Notes'], 'CALL ON ARRIVAL, Lift Required, Nickname: MICHAEL');
  const cbla = await one('MATTHEWS,SCOTT (MICHAEL)', { Comments: 'CBLA' });
  assert.equal(cbla['Tobi Tags'], 'CBLA'); // the CBLA phrase still tags (decision 2026-11-15)
  assert.equal(cbla['Booking Notes'], 'CBLA, Nickname: MICHAEL');
});

test('AT-61 DOE,(JANE): Invalid Trips with the original name', async () => {
  const r = await run([row({ 'Client Name': 'DOE,(JANE)' })]);
  assert.equal(r.destinationRows.length, 0);
  assert.equal(r.invalidRows[0]['Client Name'], 'DOE,(JANE)');
  assert.match(r.invalidRows[0]['Validation Errors'], /INVALID_CLIENT_NAME_FORMAT/);
});

test('AT-62 apostrophes are kept; an unmatched delimiter is removed and its text kept', async () => {
  const a = await one("O'BRIEN,PAT");
  assert.deepEqual([a['Last Name'], a['First Name'], a['Booking Notes']], ["O'BRIEN", 'PAT', '']);
  const b = await one('SMITH,ANN (ANNIE');
  assert.deepEqual([b['Last Name'], b['First Name'], b['Booking Notes']], ['SMITH', 'ANN ANNIE', '']);
});

test('addresses still drop ( ) [ ] and keep the text (SOURCE-SPECIAL-CHARS-001)', async () => {
  const d = await one('DOE,JANE', { DOAddress: '200 MISSION AVE (STE 5)', PUCity: '(OCEANSIDE)' });
  assert.deepEqual([d['Dropoff Address'], d['Dropoff Suite'], d['Pickup City'], d['Booking Notes']], ['200 MISSION AVE', 'STE 5', 'OCEANSIDE', '']);
});
