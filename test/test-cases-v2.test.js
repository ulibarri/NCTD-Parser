'use strict';

// Test matrix NCTD_Manifest_Parser_Test_Cases_v2.0.json (TC-001 to TC-028).
// Inputs list only the relevant fields; the other columns get valid defaults.
// Deviations agreed on 2026-11-10 (acceptance_test_suite.deviations in the
// rules): TC-012 and TC-013 route the row to Invalid Trips with
// MISSING_ID_COMPONENT instead of blocking the export; TC-017 expects the
// tag value CBLA; TC-003 and TC-015 expect First Name DEANNE (v2.3.0)
// (acceptance_test_suite.expected_overrides).

const test = require('node:test');
const assert = require('node:assert/strict');
const suite = require(`./fixtures/${require('./helpers').rules.acceptance_test_suite.baseline_file}`);
const { BASE, run, rules } = require('./helpers');

const DEFAULTS = { ...BASE, DOAppt: '', PickUpLocationName: '', DropLocationName: '', Amount: '0' };
const BLOCKING = new Set(Object.entries(rules.exceptions).filter(([, s]) => s === 'blocking').map(([c]) => c));
const ID_RE = /^[A-Za-z0-9]+$/;
const deviations = rules.acceptance_test_suite.deviations;

/** Output rows matching an expected object (by PUTime/type when given). */
function pick(result, inputs, exp, i) {
  const rows = result.destinationRows;
  if (exp.PUTime) return rows.find((d) => d['Pickup Time'].slice(11, 16) === exp.PUTime);
  if (exp.type) return rows.find((d) => (exp.type === 'CLI' ? !d['Tobi MRN'].endsWith('PCA') : d['Tobi MRN'].endsWith('PCA')));
  return rows[i];
}

for (const tc of suite.test_cases) {
  test(`${tc.id} ${tc.title}`, async () => {
    const inputs = tc.inputs.map((x) => ({ ...DEFAULTS, ...x }));
    const r = await run(inputs);
    const codes = r.exceptions.map((e) => e.code);

    const overrides = (rules.acceptance_test_suite.expected_overrides || {})[tc.id] || {};
    for (const [i, original] of tc.expected.entries()) {
      const exp = { ...original, ...overrides }; // agreed deviations (e.g. TC-017: CBLA)
      if (exp.error) {
        if (deviations[tc.id]) {
          // agreed deviation: Invalid Trips, export not blocked
          assert.ok(codes.includes(exp.error), `${exp.error} reported`);
          assert.equal(r.invalidRows.length, 1);
          assert.match(r.invalidRows[0]['Validation Errors'], new RegExp(`${exp.field}.*${exp.error}`));
          assert.equal(r.summary.exportReady, true);
        } else {
          assert.ok(codes.includes(exp.error), `expected ${exp.error}, got ${codes.join(',')}`);
          assert.ok(BLOCKING.has(exp.error));
          if ('export_ready' in exp) assert.equal(r.summary.exportReady, exp.export_ready);
        }
        continue;
      }
      if ('output_row_count' in exp) {
        assert.equal(r.destinationRows.length, exp.output_row_count);
        assert.equal(r.summary.duplicatesRemoved, exp.duplicates_removed);
        assert.equal(r.exceptions.filter((e) => e.code.endsWith('COLLISION')).length, 0);
        continue;
      }
      if (exp['Leg IDs']) {
        assert.deepEqual(r.destinationRows.map((d) => d['Leg ID']), exp['Leg IDs']);
        assert.equal(new Set(exp['Leg IDs']).size, exp['Leg IDs'].length);
        continue;
      }
      if (exp['Vendor IDs']) {
        assert.deepEqual(r.destinationRows.map((d) => d['Vendor ID']), exp['Vendor IDs']);
        continue;
      }
      if (exp.run1_vendor) {
        const second = await run(inputs);
        assert.equal(r.destinationRows[0]['Vendor ID'], exp.run1_vendor);
        assert.equal(second.destinationRows[0]['Vendor ID'], exp.run2_vendor);
        assert.equal(r.destinationRows[0]['Leg ID'], exp.run1_leg);
        assert.equal(second.destinationRows[0]['Leg ID'], exp.run2_leg);
        continue;
      }
      if (exp['Vendor ID regex']) {
        for (const d of r.destinationRows) {
          assert.match(d['Vendor ID'], new RegExp(exp['Vendor ID regex']));
          assert.match(d['Leg ID'], new RegExp(exp['Leg ID regex']));
        }
        continue;
      }
      const d = pick(r, inputs, exp, i);
      assert.ok(d, `output row for ${JSON.stringify(exp)}`);
      if (exp.Leg) assert.equal(d['Leg ID'].slice(-1), exp.Leg);
      if (exp.AlnumClientID) assert.ok(d['Vendor ID'].startsWith(exp.AlnumClientID));
      for (const [k, v] of Object.entries(exp)) {
        if (['PUTime', 'Leg', 'type', 'AlnumClientID'].includes(k)) continue;
        assert.equal(d[k], v, `${k}`);
      }
    }

    // global assertions for every case
    for (const d of r.destinationRows) {
      if (d['Leg ID']) assert.match(d['Leg ID'], ID_RE);
      assert.match(d['Vendor ID'], ID_RE);
      assert.ok(!/_PCA|-PCA|PCAPCA/.test(d['Tobi MRN'] + d['Vendor ID'] + d['Leg ID']));
    }
  });
}
