'use strict';

// v2.8.0: LEG-ID-V2-SEQUENTIAL-001 (AT-54 to AT-58).

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { rules, row, returnOf, run, table } = require('./helpers');
const { parseSequenceStart } = require('../src/parser/pipeline');

const input = () => {
  const a = row();
  return [a, returnOf(a), row({ 'Passenger Ty': 'PCA' }), row({ 'Client ID': '2002', 'Client Name': 'ROE,JOE', PUTime: '09:10:00' })];
};
const ids = (r, col) => r.destinationRows.map((d) => d[col]);

test('rules: v2.8.0 adds the consecutive option (L + 6 digits, start 1..999999)', () => {
  const o = rules.experimental_rules.leg_id_v2.sequential_option;
  assert.equal(o.label.es, 'Asignar números consecutivos a Leg ID V2');
  assert.deepEqual([o.format.prefix, o.format.digits, o.start.default], ['L', 6, 1]);
  assert.equal(rules.exceptions.LEG_ID_V2_SEQUENCE_OVERFLOW, 'blocking');
  assert.ok(rules.acceptance_tests.some((t) => t.id === 'AT-58'));
});

test('AT-54 start 1: L000001, L000002, ... in Output row order', async () => {
  const r = await run(input(), { legIdV2Sequence: { start: 1 } });
  assert.deepEqual(ids(r, 'Leg ID V2'), ['L000001', 'L000002', 'L000003', 'L000004']);
  assert.deepEqual(r.summary.legIdV2Sequence, { start: 1, first: 'L000001', last: 'L000004', nextStart: 5 });
  assert.ok(r.summary.exportReady);
});

test('AT-55 start 93 continues the previous file', async () => {
  const r = await run(input(), { legIdV2Sequence: { start: 93 } });
  assert.deepEqual(ids(r, 'Leg ID V2'), ['L000093', 'L000094', 'L000095', 'L000096']);
  assert.equal(r.summary.legIdV2Sequence.nextStart, 97);
});

test('AT-56 only Leg ID V2 changes; reprocessing gives the same numbers', async () => {
  const off = await run(input());
  const on = await run(input(), { legIdV2Sequence: { start: 1 } });
  for (const col of rules.destination_columns.filter((c) => c !== 'Leg ID V2')) assert.deepEqual(ids(on, col), ids(off, col), col);
  assert.deepEqual(on.catalog, off.catalog);
  assert.equal(off.summary.legIdV2Sequence, null);
  const again = await run(input(), { legIdV2Sequence: { start: 1 } });
  assert.deepEqual(ids(again, 'Leg ID V2'), ids(on, 'Leg ID V2'));
  // works with the experimental mode too (no collision: numbers are unique)
  const mode = await run(input(), { legIdV2Mode: true, legIdV2Sequence: { start: 1 } });
  assert.ok(mode.summary.exportReady);
});

test('AT-57 invalid start numbers are rejected', () => {
  for (const bad of ['0', '1.5', 'abc', '', '1000000', '-3', '1e3', null]) {
    assert.equal(parseSequenceStart(bad === null ? 'x' : bad, rules), null, String(bad));
  }
  assert.equal(parseSequenceStart('93', rules), 93);
  assert.equal(parseSequenceStart(' 7 ', rules), 7);
  assert.equal(parseSequenceStart(undefined, rules), 1); // default
});

test('AT-58 numbers past L999999 block the Output', async () => {
  const r = await run(input(), { legIdV2Sequence: { start: 999998 } });
  const exc = r.exceptions.find((e) => e.code === 'LEG_ID_V2_SEQUENCE_OVERFLOW');
  assert.equal(exc.severity, 'blocking');
  assert.equal(r.summary.exportReady, false);
  const edge = await run(input(), { legIdV2Sequence: { start: 999996 } });
  assert.equal(ids(edge, 'Leg ID V2').at(-1), 'L999999');
  assert.ok(edge.summary.exportReady);
});

test('API: legIdV2Sequential with a bad start answers 400 INVALID_SEQUENCE_START', async () => {
  const { createApiRouter } = require('../src/routes/api');
  const { TtlStore } = require('../src/store');
  const uploads = new TtlStore(60000);
  const jobs = new TtlStore(60000);
  const id = uploads.add({ kind: 'viajes', filename: 'NCTD_Trips_10.23.26_1.xlsx', table: table(input()) });
  const app = express().use(express.json()).use('/api', createApiRouter({ rules, uploads, jobs }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/jobs`;
  const post = (body) => fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const bad = await post({ viajesUploadId: id, legIdV2Sequential: true, legIdV2Start: '0' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'INVALID_SEQUENCE_START');
    const ok = await post({ viajesUploadId: id, legIdV2Sequential: true, legIdV2Start: '93' });
    assert.equal(ok.status, 200);
    const job = await ok.json();
    assert.equal(job.summary.legIdV2Sequence.first, 'L000093');
  } finally {
    server.close();
  }
});
