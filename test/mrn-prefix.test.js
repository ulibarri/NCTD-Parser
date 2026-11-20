'use strict';

// v2.11.0 MRN-PREFIX-001 and CATALOG-MRN-PREFIX-MIGRATION-001: AT-80 to AT-84.

const test = require('node:test');
const assert = require('node:assert/strict');
const { stringify } = require('csv-stringify/sync');
const { rules, row, run, catalog } = require('./helpers');
const { createApp } = require('../server');
const { createMemoryStore } = require('../src/catalog-store');
const { migrateMrnPrefix } = require('../src/catalog-migrations');
const { withPrefix } = require('../src/parser/fields');

test('rules: v2.11.0 NCTD prefix', () => {
  assert.ok(rules.specification.changelog.some((c) => c.version === '2.11.0'));
  assert.equal(rules.field_rules.tobi_mrn.prefix, 'NCTD');
  assert.equal(rules.field_rules.tobi_mrn.rule_id, 'MRN-PREFIX-001');
  assert.equal(rules.passenger_catalog.mrn_prefix_migration.rule_id, 'CATALOG-MRN-PREFIX-MIGRATION-001');
  assert.equal(rules.exceptions.CATALOG_MRN_PREFIX_PENDING, 'warning');
  assert.ok(rules.passenger_catalog.key.comparison, 'v2.5.0 key rules kept by the deep merge');
  assert.equal(withPrefix('1365', 'NCTD'), 'NCTD1365');
  assert.equal(withPrefix('nctd1365', 'NCTD'), 'nctd1365');
  assert.equal(withPrefix('', 'NCTD'), '');
});

test('AT-80 Tobi MRN starts with NCTD; other identifiers do not change', async () => {
  const r = await run([
    row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,REBECCA' }),
    row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,REBECCA', 'Passenger Ty': 'PCA' }),
    row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,ANN', 'Passenger Ty': 'COM', PUTime: '09:00' }),
    row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,ANN', 'Passenger Ty': 'COMP', PUTime: '10:00' }),
    row({ 'Client ID': '82-475', 'Client Name': 'ROE,JOHN', PUTime: '11:00' }),
    row({ 'Client ID': 'NCTD2002', 'Client Name': 'DOE,JOHN', PUTime: '12:00' }),
  ]);
  assert.deepEqual(r.destinationRows.map((d) => d['Tobi MRN']), ['NCTD1365', 'NCTD1365PCA', 'NCTD1365COM', 'NCTD1365COM', 'NCTD82475', 'NCTD2002']);
  const cli = r.destinationRows[0];
  assert.equal(cli['Vendor ID'], '1365202610230755');
  assert.equal(cli['Leg ID'], '1365202610230755A');
  assert.equal(cli['Leg ID V2'], '1365202610230755A');
  assert.equal(r.destinationRows[1]['Vendor ID'], '1365202610230755PCA');
  assert.equal(r.destinationRows[1]['Leg ID V2'], '1365202610230755PCA');
  assert.ok(r.summary.exportReady);
});

test('AT-81 Pasajeros CSV without prefix: known passengers match and get NCTD', async () => {
  const cat = catalog([
    { 'First Name': 'REBECCA', 'Last Name': 'LEDTKE', 'MRN Number': '1365', Telephone: '7605551365' },
    { 'First Name': 'REBECCA-PCA', 'Last Name': 'LEDTKE', 'MRN Number': '1365PCA', Telephone: '7605551366' },
    { 'First Name': 'JOHN', 'Last Name': 'DOE', 'MRN Number': 'NCTD2002', Telephone: '7605552002' },
  ]);
  const r = await run([
    row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,BECKY', Comments: 'C: 760-555-0000' }),
    row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,REBECCA', 'Passenger Ty': 'PCA' }),
  ], { catalog: cat });
  assert.equal(r.summary.catalogMatched, 2);
  assert.equal(r.summary.pasajerosAdded, 0);
  assert.equal(r.summary.catalogMrnPrefixed, 2);
  assert.equal(r.destinationRows[0]['First Name'], 'REBECCA');
  assert.equal(r.destinationRows[0]['Primary Phone'], '7605551365');
  assert.deepEqual(r.catalog.rows.map((c) => c['MRN Number']), ['NCTD1365', 'NCTD1365PCA', 'NCTD2002']);
  const again = await run([row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,REBECCA' })], { catalog: catalog(r.catalog.rows) });
  assert.equal(again.summary.catalogMrnPrefixed, 0);
  assert.deepEqual(again.catalog.rows, r.catalog.rows);
});

// ---------- database mode before the table is migrated (AT-82) ----------
const KEY = 'k';
const viajesCsv = (rows) => stringify([rules.source_columns, ...rows.map((x) => rules.source_columns.map((c) => x[c] ?? ''))]);
const pasajerosCsv = (rows) => stringify([['First Name', 'Last Name', 'MRN Number', 'Telephone'], ...rows.map((x) => [x['First Name'], x['Last Name'], x['MRN Number'], x.Telephone])]);

async function withApp(store, fn) {
  const server = createApp({ rules, catalogStore: store, accessKey: KEY }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (p, { method = 'GET', json, file } = {}) => {
    const headers = { 'X-Catalog-Key': KEY };
    let body;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (file) { body = new FormData(); body.append('file', new Blob([file.content]), file.name); }
    const res = await fetch(base + p, { method, headers, body });
    const text = await res.text();
    try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
  };
  const process = async (rows) => {
    const up = await call('/uploads/viajes', { method: 'POST', file: { name: 'CFS_11.19.26.csv', content: viajesCsv(rows) } });
    return call('/jobs', { method: 'POST', json: { viajesUploadId: up.data.uploadId } });
  };
  try { await fn({ call, process }); } finally { server.close(); }
}

const legacyStore = () => createMemoryStore({
  items: [
    { mrn: '1365', firstName: 'REBECCA', lastName: 'LEDTKE', mrnNumber: '1365', telephone: '7605551365', addedAt: '2026-11-16T00:00:00.000Z', ord: 0 },
    { mrn: '1365PCA', firstName: 'REBECCA-PCA', lastName: 'LEDTKE', mrnNumber: '1365PCA', telephone: '7605551366', addedAt: '2026-11-16T00:00:00.000Z', ord: 1 },
  ],
});

test('AT-82 database not migrated yet: passengers match, nothing to save, warning', async () => {
  const store = legacyStore();
  const before = JSON.stringify([...store.data.entries()]);
  await withApp(store, async ({ call, process }) => {
    const r = await process([
      row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,BECKY' }),
      row({ 'Client ID': '1365', 'Client Name': 'LEDTKE,REBECCA', 'Passenger Ty': 'PCA' }),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.rows.map((d) => [d['Tobi MRN'], d['First Name'], d['Primary Phone']]), [
      ['NCTD1365', 'REBECCA', '7605551365'], ['NCTD1365PCA', 'REBECCA-PCA', '7605551366']]);
    assert.deepEqual(r.data.summary.catalogPending, { added: 0, changed: 0, legIdV2: null });
    assert.equal(r.data.summary.catalogMrnPrefixPending, 2);
    const w = r.data.exceptions.find((e) => e.code === 'CATALOG_MRN_PREFIX_PENDING');
    assert.deepEqual([w.severity, w.count], ['warning', 2]);
    assert.ok(r.data.summary.exportReady);
    await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    assert.equal(JSON.stringify([...store.data.entries()]), before, 'the table is not written');
    // importing the old CSV again does not duplicate passengers stored without prefix
    const imp = await call('/catalog/import', { method: 'POST', file: { name: 'old.csv', content: pasajerosCsv([{ 'First Name': 'X', 'Last Name': 'Y', 'MRN Number': '1365', Telephone: '7605550000' }]) } });
    assert.deepEqual([imp.data.saved, imp.data.existed, imp.data.mrnPrefixed], [0, 1, 1]);
    assert.equal(store.data.size, 2);
  });
});

// ---------- migration script core (AT-83, AT-84) ----------
function fakeDynamo(initial) {
  const items = new Map(initial.map((i) => [i.mrn, { ...i }]));
  class Cmd { constructor(input) { this.input = input; } }
  const commands = { ScanCommand: class extends Cmd {}, TransactWriteCommand: class extends Cmd {}, DeleteCommand: class extends Cmd {} };
  const writes = [];
  const holds = (cur, c) => {
    if (!cur) return false;
    const names = c.ExpressionAttributeNames || {};
    const vals = c.ExpressionAttributeValues || {};
    return c.ConditionExpression.split(' AND ').every((part) => {
      let m;
      if ((m = /^attribute_exists\((#\w+)\)$/.exec(part))) return cur[names[m[1]]] !== undefined;
      if ((m = /^attribute_not_exists\((#\w+)\)$/.exec(part))) return cur[names[m[1]]] === undefined;
      if ((m = /^(#\w+) = (:\w+)$/.exec(part))) return cur[names[m[1]]] === vals[m[2]];
      throw new Error(`unexpected condition ${part}`);
    });
  };
  const client = {
    async send(cmd) {
      const i = cmd.input;
      if (cmd instanceof commands.ScanCommand) return { Items: [...items.values()].map((x) => ({ ...x })) };
      writes.push(cmd);
      if (cmd instanceof commands.DeleteCommand) {
        if (!holds(items.get(i.Key.mrn), i)) throw Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' });
        items.delete(i.Key.mrn);
        return {};
      }
      const [{ Put }, { Delete }] = i.TransactItems;
      assert.equal(Put.ConditionExpression, 'attribute_not_exists(mrn)');
      if (items.has(Put.Item.mrn) || !holds(items.get(Delete.Key.mrn), Delete)) throw Object.assign(new Error('x'), { name: 'TransactionCanceledException' });
      items.set(Put.Item.mrn, { ...Put.Item });
      items.delete(Delete.Key.mrn);
      return {};
    },
  };
  return { client, commands, items, writes };
}

const SEED = [
  { mrn: '1365', firstName: 'REBECCA', lastName: 'LEDTKE', mrnNumber: '1365', telephone: '7605551365', addedAt: '2026-11-16T00:00:00.000Z', ord: 0, source: 'CFS_11.16.26.xlsx' },
  { mrn: '82475PCA', firstName: 'DEANNE-PCA', lastName: 'ALLOUCHE', mrnNumber: '82475_PCA', telephone: '8584020500', addedAt: '2026-11-16T00:00:00.000Z', ord: 1 },
  { mrn: 'NCTD2002', firstName: 'JOHN', lastName: 'DOE', mrnNumber: 'NCTD2002', telephone: '7605552002', addedAt: '2026-11-18T00:00:00.000Z', ord: 0 },
  { mrn: '#LEG_ID_V2_SEQ', last: 42, updatedAt: '2026-11-18T00:00:00.000Z' },
];

test('AT-83 migration: dry run writes nothing; apply moves each passenger once', async () => {
  const fake = fakeDynamo(SEED);
  const dry = await migrateMrnPrefix({ ...fake, table: 't', prefix: 'NCTD' });
  assert.equal(fake.writes.length, 0);
  assert.deepEqual(dry.toMove.map((m) => [m.from, m.to, m.mrnNumber]), [['1365', 'NCTD1365', 'NCTD1365'], ['82475PCA', 'NCTD82475PCA', 'NCTD82475_PCA']]);
  assert.deepEqual([dry.passengers, dry.alreadyPrefixed], [3, 1]);

  let backup = null;
  const res = await migrateMrnPrefix({ ...fake, table: 't', prefix: 'NCTD', apply: true, beforeWrite: (items) => { backup = items; } });
  assert.equal(backup.length, 4);
  assert.deepEqual(res.moved.map((m) => m.to), ['NCTD1365', 'NCTD82475PCA']);
  assert.deepEqual([res.failed, res.conflicts], [[], []]);
  assert.deepEqual([...fake.items.keys()].sort(), ['#LEG_ID_V2_SEQ', 'NCTD1365', 'NCTD2002', 'NCTD82475PCA']);
  assert.deepEqual(fake.items.get('NCTD1365'), { ...SEED[0], mrn: 'NCTD1365', mrnNumber: 'NCTD1365' });
  assert.deepEqual(fake.items.get('#LEG_ID_V2_SEQ'), SEED[3]);

  const writes = fake.writes.length;
  const again = await migrateMrnPrefix({ ...fake, table: 't', prefix: 'NCTD', apply: true });
  assert.equal(fake.writes.length, writes, 'second run writes nothing');
  assert.deepEqual([again.moved.length, again.alreadyPrefixed], [0, 3]);
});

test('AT-84 migration when the prefixed item already exists', async () => {
  const fake = fakeDynamo([
    SEED[0],
    { ...SEED[0], mrn: 'NCTD1365', mrnNumber: 'NCTD1365', addedAt: '2026-11-19T00:00:00.000Z' }, // same data
    { mrn: '3003', firstName: 'ANA', lastName: 'LOPEZ', mrnNumber: '3003', telephone: '7605550001' },
    { mrn: 'NCTD3003', firstName: 'ANITA', lastName: 'LOPEZ', mrnNumber: 'NCTD3003', telephone: '7605550002' }, // different
  ]);
  const res = await migrateMrnPrefix({ ...fake, table: 't', prefix: 'NCTD', apply: true });
  assert.deepEqual(res.deletedOnly, [{ from: '1365', to: 'NCTD1365' }]);
  assert.deepEqual(res.conflicts.map((c) => c.from), ['3003']);
  assert.deepEqual([...fake.items.keys()].sort(), ['3003', 'NCTD1365', 'NCTD3003']);
  assert.equal(fake.items.get('NCTD1365').addedAt, '2026-11-19T00:00:00.000Z');
});

test('migration: an item changed after the scan is not moved', async () => {
  const fake = fakeDynamo([SEED[0]]);
  const original = fake.client.send.bind(fake.client);
  fake.client.send = async (cmd) => {
    if (cmd instanceof fake.commands.TransactWriteCommand) fake.items.get('1365').telephone = '7605559999'; // someone saved in between
    return original(cmd);
  };
  const res = await migrateMrnPrefix({ ...fake, table: 't', prefix: 'NCTD', apply: true });
  assert.deepEqual(res.failed.map((f) => [f.from, f.error]), [['1365', 'TransactionCanceledException']]);
  assert.deepEqual([...fake.items.keys()], ['1365']);
});
