'use strict';

// v2.6.0 overlay: LEG-ID-V2-EXPERIMENTAL-001 (AT-39 to AT-44) and the overlay loader.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rules, row, returnOf, run } = require('./helpers');
const { readRules } = require('../src/rules');

const v2 = (r) => r.destinationRows.map((d) => [d['Passenger Ty'] || '', d['Leg ID'], d['Leg ID V2']]);
const byType = (r, companion) => r.destinationRows.filter((d) => /(PCA|COM)$/.test(d['Tobi MRN']) === companion);

test('overlay chain v2.13.0 -> v2.12.0 -> v2.11.0 -> v2.10.0 -> v2.9.0 -> v2.8.3 -> v2.8.2 -> v2.8.1 -> v2.8.0 -> v2.7.1 -> v2.7.0 -> v2.6.0 -> v2.5.0 (37 columns, Leg ID V2 after Leg ID, AT-01..AT-90)', () => {
  assert.equal(rules.specification.version, '2.13.0');
  assert.equal(rules.destination_columns.length, 37);
  assert.deepEqual(rules.destination_columns.slice(0, 3), ['Vendor ID', 'Leg ID', 'Leg ID V2']);
  assert.equal(rules.processing_pipeline[rules.processing_pipeline.indexOf('generate_leg_id') + 1], 'generate_leg_id_v2');
  assert.deepEqual(rules.acceptance_tests.map((t) => t.id), Array.from({ length: 90 }, (_, i) => `AT-${String(i + 1).padStart(2, '0')}`));
  // v2.5.0 rules are still active
  assert.ok(rules.normalization.source_character_cleanup);
  assert.equal(rules.exceptions.INVALID_CLIENT_NAME_FORMAT, 'error');
  assert.ok(rules.deployment_policy.catalog_versions);
  assert.deepEqual(rules.specification.changelog.slice(0, 13).map((c) => c.version), ['2.13.0', '2.12.0', '2.11.0', '2.10.0', '2.9.0', '2.8.3', '2.8.2', '2.8.1', '2.8.0', '2.7.1', '2.7.0', '2.6.0', '2.5.0']);
  assert.equal(rules.passenger_catalog.migration_rules.length, 1);
  assert.ok(!Object.keys(rules).some((k) => k.endsWith('_patch')));
});

test('overlay: a missing base file or an unknown patch is an error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  const f = path.join(dir, 'x.json');
  fs.writeFileSync(f, JSON.stringify({ specification: { extends: { file: 'nope.json' } } }));
  assert.throws(() => readRules(f), /base file nope.json not found/);
  fs.writeFileSync(f, JSON.stringify({ specification: { extends: { file: 'nctd_manifest_parser_rules_v2.5.0.json' } }, foo_patch: {} }));
  assert.throws(() => readRules(f), /unknown patch foo_patch/);
});

test('AT-39 single CLI leg: Leg ID V2 = Leg ID; v2.5.0 fields unchanged', async () => {
  const r = await run([row()]);
  const d = r.destinationRows[0];
  assert.equal(d['Leg ID V2'], d['Leg ID']);
  assert.equal(d['Vendor ID'], '1001202610230755');
  assert.equal(d['Leg ID'], '1001202610230755A');
  assert.equal(d['Pair Status'], 'Unpaired');
  assert.deepEqual(Object.keys(d), rules.destination_columns);
});

test('AT-40 CLI and PCA single leg: PCA Leg ID V2 = PCA Vendor ID, values differ', async () => {
  const r = await run([row(), row({ 'Passenger Ty': 'PCA' })]);
  const [cli] = byType(r, false);
  const [pca] = byType(r, true);
  assert.equal(cli['Leg ID V2'], '1001202610230755A');
  assert.equal(pca['Leg ID V2'], '1001202610230755PCA');
  assert.equal(pca['Leg ID'], '1001202610230755PCAA'); // unchanged
  assert.notEqual(cli['Leg ID V2'], pca['Leg ID V2']);
});

test('AT-41 CLI reciprocal A/B: each Leg ID V2 = its Leg ID', async () => {
  const a = row();
  const r = await run([a, returnOf(a)]);
  assert.deepEqual(r.destinationRows.map((d) => d['Leg ID V2']), ['1001202610230755A', '1001202610231500B']);
  assert.deepEqual(r.destinationRows.map((d) => d['Pair Status']), ['Paired', 'Paired']);
});

test('AT-42 CLI and PCA reciprocal A/B: four different Leg ID V2 values', async () => {
  const a = row();
  const p = row({ 'Passenger Ty': 'COMP' });
  const r = await run([a, returnOf(a), p, returnOf(p)]);
  const ids = r.destinationRows.map((d) => d['Leg ID V2']).sort();
  assert.deepEqual(ids, ['1001202610230755A', '1001202610230755COM', '1001202610231500B', '1001202610231500COM']); // COMP -> COM (v2.7.0)
  assert.equal(new Set(ids).size, 4);
  for (const d of byType(r, true)) assert.equal(d['Leg ID V2'], d['Vendor ID']);
  assert.deepEqual(byType(r, true).map((d) => d['Leg ID']), ['1001202610230755COMA', '1001202610231500COMB']);
  assert.ok(r.summary.exportReady);
});

test('AT-43 reprocessing gives the same Leg ID V2 values', async () => {
  const input = [row(), returnOf(row()), row({ 'Passenger Ty': 'PCA' })];
  const one = await run(input, { legIdV2Mode: true });
  const two = await run(input, { legIdV2Mode: true });
  assert.deepEqual(one.destinationRows.map((d) => d['Leg ID V2']), two.destinationRows.map((d) => d['Leg ID V2']));
});

test('AT-44 duplicate Leg ID V2 blocks the export in experimental mode', async () => {
  // same client and minute, different dropoff: not an exact duplicate
  const rows = [row(), row({ DOAddress: '999 OTHER RD' })];
  const on = await run(rows, { legIdV2Mode: true });
  const exc = on.exceptions.find((e) => e.code === 'LEG_ID_V2_COLLISION');
  assert.equal(exc.severity, 'blocking');
  assert.equal(on.summary.exportReady, false);
  assert.equal(on.summary.legIdV2Mode, true);
  const off = await run(rows);
  assert.equal(off.exceptions.find((e) => e.code === 'LEG_ID_V2_COLLISION').severity, 'warning');
});

test('standard mode: Leg ID V2 column present, mode off, nothing else changes', async () => {
  const r = await run([row(), row({ 'Passenger Ty': 'PCA' })]);
  assert.equal(r.summary.legIdV2Mode, false);
  assert.equal(r.summary.legIdV2ModeName, 'TOBI_INDEPENDENT_LEGS_V2');
  assert.ok(r.summary.exportReady);
  assert.ok(r.destinationRows.every((d) => d['Leg ID V2']));
  assert.equal(r.destinationColumns.length, 37);
});
