'use strict';

// v2.8.3: CATALOG-STORAGE-001 (AT-65 to AT-69), with the in-memory store and
// with the DynamoDB store over a fake client.

const test = require('node:test');
const assert = require('node:assert/strict');
const { stringify } = require('csv-stringify/sync');
const { rules, row } = require('./helpers');
const { createApp } = require('../server');
const { createMemoryStore, createDynamoStore, storeFromEnv, diffCatalog } = require('../src/catalog-store');

const KEY = 'clave-de-prueba';
const COLS = ['First Name', 'Last Name', 'MRN Number', 'Telephone'];
const viajesCsv = (rows) => stringify([rules.source_columns, ...rows.map((r) => rules.source_columns.map((c) => r[c] ?? ''))]);
const pasajerosCsv = (rows) => stringify([COLS, ...rows.map((r) => COLS.map((c) => r[c] ?? ''))]);

async function withApp(store, fn) {
  const server = createApp({ rules, catalogStore: store, accessKey: KEY }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, { method = 'GET', key = KEY, json, file } = {}) => {
    const headers = key ? { 'X-Catalog-Key': key } : {};
    let body;
    if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (file) { body = new FormData(); body.append('file', new Blob([file.content], { type: 'text/csv' }), file.name); }
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data };
  };
  const process = async (rows, key = KEY) => {
    const up = await call('/uploads/viajes', { method: 'POST', file: { name: 'CFS_11.16.26.csv', content: viajesCsv(rows) } });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    return call('/jobs', { method: 'POST', key, json: { viajesUploadId: up.data.uploadId } });
  };
  try {
    await fn({ call, process });
  } finally {
    server.close();
  }
}

const seed = () => createMemoryStore({
  table: 'nctd-passengers-stage',
  items: [{ mrn: '1001', firstName: 'JANE', lastName: 'DOE', mrnNumber: '1001', telephone: '7605550101', addedAt: '2026-11-16T00:00:00.000Z', ord: 0 }],
});

test('rules: v2.8.3 catalog storage', () => {
  assert.equal(rules.specification.version, '2.8.3');
  const s = rules.passenger_catalog.storage;
  assert.equal(s.rule_id, 'CATALOG-STORAGE-001');
  assert.deepEqual(s.tables, { prod: 'nctd-passengers-prod', stage: 'nctd-passengers-stage' });
  assert.equal(rules.exceptions.CATALOG_KEY_INVALID, 'error');
  assert.equal(rules.field_rules.phones['Primary Phone'].default, '8584020500');
});

test('AT-65 database mode: the catalog comes from the table and processing writes nothing', async () => {
  const store = seed();
  await withApp(store, async ({ call, process }) => {
    const status = await call('/catalog/status', { key: '' });
    assert.deepEqual(status.data, { mode: 'memory', table: 'nctd-passengers-stage', keyRequired: true });
    const r = await process([
      row({ 'Client Name': 'DOE ,JANIE', Comments: 'CELL 858-555-0199' }),
      row({ 'Client ID': '2002', 'Client Name': 'ROE,JOHN', PUTime: '09:00' }),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const byMrn = Object.fromEntries(r.data.rows.map((d) => [d['Tobi MRN'], d]));
    assert.equal(byMrn['1001']['First Name'], 'JANE');
    assert.equal(byMrn['1001']['Primary Phone'], '7605550101');
    assert.equal(byMrn['2002']['Primary Phone'], '8584020500');
    assert.equal(r.data.summary.catalogMatched, 1);
    assert.deepEqual(r.data.summary.catalogPending, { added: 1, changed: 0 });
    assert.equal(r.data.summary.catalogTable, 'nctd-passengers-stage');
    assert.ok(!r.data.exceptions.some((e) => e.code === 'NO_PASSENGER_CATALOG'));
    assert.equal(store.data.size, 1);
  });
});

test('AT-66 save to catalog writes the new passengers once', async () => {
  const store = seed();
  await withApp(store, async ({ call, process }) => {
    const r = await process([row(), row({ 'Client ID': '2002', 'Client Name': 'ROE,JOHN', 'Passenger Ty': 'PCA', PUTime: '09:00' })]);
    const first = await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    assert.equal(first.status, 200);
    assert.deepEqual({ saved: first.data.saved, existed: first.data.existed, stale: first.data.stale }, { saved: 1, existed: 0, stale: false });
    const second = await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    assert.equal(second.data.alreadySaved, true);
    const list = await call('/catalog');
    assert.deepEqual(list.data.rows, [
      { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' },
      { 'First Name': 'JOHN-PCA', 'Last Name': 'ROE', 'MRN Number': '2002PCA', Telephone: '8584020500' },
    ]);
    // the next day the passenger comes from the table
    const day2 = await process([row({ 'Client ID': '2002', 'Client Name': 'ROE,JOHNNY', 'Passenger Ty': 'PCA', Comments: 'C: 760-555-0110' })]);
    assert.equal(day2.data.rows[0]['First Name'], 'JOHN-PCA');
    assert.equal(day2.data.rows[0]['Primary Phone'], '8584020500');
    assert.deepEqual(day2.data.summary.catalogPending, { added: 0, changed: 0 });
    const backup = await call('/catalog/export');
    assert.match(backup.data, /^First Name,Last Name,MRN Number,Telephone\r?\n/);
    assert.match(backup.data, /JOHN-PCA,ROE,2002PCA,8584020500/);
  });
});

test('AT-67 a passenger saved by another job keeps its stored values', async () => {
  const store = seed();
  await withApp(store, async ({ call, process }) => {
    const a = await process([row({ 'Client ID': '3003', 'Client Name': 'LOPEZ,ANA', Comments: 'C: 760-555-0001' })]);
    const b = await process([row({ 'Client ID': '3003', 'Client Name': 'LOPEZ,ANITA', Comments: 'C: 760-555-0002' })]);
    assert.equal((await call(`/jobs/${b.data.jobId}/catalog`, { method: 'POST' })).data.saved, 1);
    const late = await call(`/jobs/${a.data.jobId}/catalog`, { method: 'POST' });
    assert.deepEqual({ saved: late.data.saved, existed: late.data.existed, stale: late.data.stale, ids: late.data.existedIds }, { saved: 0, existed: 1, stale: true, ids: ['3003'] });
    const again = await process([row({ 'Client ID': '3003', 'Client Name': 'LOPEZ,ANA' })]);
    assert.equal(again.data.rows[0]['First Name'], 'ANITA');
    assert.equal(again.data.rows[0]['Primary Phone'], '7605550002');
  });
});

test('AT-68 import CSV: migrations, first repeated row wins, existing MRN kept', async () => {
  const store = seed();
  await withApp(store, async ({ call }) => {
    const content = pasajerosCsv([
      { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605559999' },
      { 'First Name': 'DEANNE', 'Last Name': 'ALLOUCHE COMPANION', 'MRN Number': '82475PCA', Telephone: '9876543210' },
      { 'First Name': 'DEANNE', 'Last Name': 'ALLOUCHE', 'MRN Number': '82475', Telephone: '7605550300' },
      { 'First Name': 'OTHER', 'Last Name': 'ALLOUCHE', 'MRN Number': '82475', Telephone: '7605550301' },
    ]);
    const r = await call('/catalog/import', { method: 'POST', file: { name: 'NCTD_Passengers_20261116_UPDTD.csv', content } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual({ read: r.data.read, saved: r.data.saved, existed: r.data.existed, duplicates: r.data.duplicates, phonesMigrated: r.data.phonesMigrated },
      { read: 4, saved: 2, existed: 1, duplicates: 1, phonesMigrated: 1 });
    const rows = (await call('/catalog')).data.rows;
    assert.deepEqual(rows, [
      { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' },
      { 'First Name': 'DEANNE-PCA', 'Last Name': 'ALLOUCHE', 'MRN Number': '82475PCA', Telephone: '8584020500' },
      { 'First Name': 'DEANNE', 'Last Name': 'ALLOUCHE', 'MRN Number': '82475', Telephone: '7605550300' },
    ]);
  });
});

test('AT-68b a catalog migration updates the stored item only through Save to catalog', async () => {
  const store = createMemoryStore({ items: [{ mrn: '1001PCA', firstName: 'JANE', lastName: 'DOE COMPANION', mrnNumber: '1001PCA', telephone: '9876543210', addedAt: '2026-11-01T00:00:00.000Z', ord: 0 }] });
  await withApp(store, async ({ call, process }) => {
    const r = await process([row({ 'Passenger Ty': 'PCA' })]);
    assert.deepEqual(r.data.summary.catalogPending, { added: 0, changed: 1 });
    assert.equal(r.data.rows[0]['First Name'], 'JANE-PCA');
    assert.equal(store.data.get('1001PCA').lastName, 'DOE COMPANION');
    const s = await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    assert.equal(s.data.updated, 1);
    assert.deepEqual(store.data.get('1001PCA'), { ...store.data.get('1001PCA'), firstName: 'JANE-PCA', lastName: 'DOE', telephone: '8584020500' });
  });
});

test('AT-69 the access key is required in database mode', async () => {
  await withApp(seed(), async ({ call, process }) => {
    for (const key of ['', 'wrong']) {
      assert.equal((await call('/catalog', { key })).status, 401);
      assert.equal((await call('/catalog/export', { key })).status, 401);
      assert.equal((await call('/catalog/import', { method: 'POST', key, file: { name: 'p.csv', content: pasajerosCsv([]) } })).status, 401);
      const r = await process([row()], key);
      assert.deepEqual([r.status, r.data.error], [401, 'CATALOG_KEY_INVALID']);
    }
    const ok = await process([row()]);
    assert.equal((await call(`/jobs/${ok.data.jobId}/catalog`, { method: 'POST', key: 'wrong' })).status, 401);
  });
  assert.throws(() => storeFromEnv({ CATALOG_STORE: 'dynamodb', CATALOG_TABLE: 't', AWS_REGION: 'us-west-2' }), /CATALOG_ACCESS_KEY/);
  assert.throws(() => storeFromEnv({ CATALOG_STORE: 'dynamodb', CATALOG_ACCESS_KEY: 'k', AWS_REGION: 'us-west-2' }), /CATALOG_TABLE/);
  assert.throws(() => storeFromEnv({ CATALOG_STORE: 'mysql' }), /not supported/);
  assert.equal(storeFromEnv({ CATALOG_STORE: 'memory', CATALOG_TABLE: 'm', CATALOG_ACCESS_KEY: 'k' }).kind, 'memory');
  assert.equal(storeFromEnv({}), null);
  assert.equal(storeFromEnv({ CATALOG_STORE: 'dynamodb', CATALOG_TABLE: 't', AWS_REGION: 'us-west-2', CATALOG_ACCESS_KEY: 'k' }).table, 't');
});

test('CSV mode is unchanged: no key, catalog endpoints disabled', async () => {
  const server = createApp({ rules, catalogStore: null }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    assert.deepEqual(await (await fetch(`${base}/catalog/status`)).json(), { mode: 'csv', table: null, keyRequired: false });
    assert.equal((await fetch(`${base}/catalog`)).status, 404);
  } finally {
    server.close();
  }
});

test('store unavailable: processing stops with CATALOG_STORE_UNAVAILABLE', async () => {
  const broken = { kind: 'dynamodb', table: 'x', list: async () => { throw Object.assign(new Error('no route'), { name: 'UnrecognizedClientException' }); } };
  await withApp(broken, async ({ process }) => {
    const r = await process([row()]);
    assert.deepEqual([r.status, r.data.error], [503, 'CATALOG_STORE_UNAVAILABLE']);
  });
});

// ---------- DynamoDB store over a fake client ----------
function fakeDynamo() {
  const items = new Map();
  const sent = [];
  class Cmd { constructor(input) { this.input = input; } }
  const commands = { ScanCommand: class extends Cmd {}, PutCommand: class extends Cmd {}, UpdateCommand: class extends Cmd {} };
  const fail = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  const client = {
    async send(cmd) {
      sent.push(cmd);
      const i = cmd.input;
      if (cmd instanceof commands.ScanCommand) {
        // two pages, to exercise pagination
        const all = [...items.values()];
        const start = i.ExclusiveStartKey ? i.ExclusiveStartKey.n : 0;
        const page = all.slice(start, start + 2);
        return { Items: page, ...(start + 2 < all.length ? { LastEvaluatedKey: { n: start + 2 } } : {}) };
      }
      if (cmd instanceof commands.PutCommand) {
        assert.equal(i.ConditionExpression, 'attribute_not_exists(mrn)');
        if (items.has(i.Item.mrn)) throw fail();
        items.set(i.Item.mrn, { ...i.Item });
        return {};
      }
      if (cmd instanceof commands.UpdateCommand) {
        const item = items.get(i.Key.mrn);
        const names = i.ExpressionAttributeNames;
        const vals = i.ExpressionAttributeValues;
        const holds = item && Object.keys(names).every((n) => item[names[n]] === vals[`:old${n.slice(2)}`]);
        if (!holds) throw fail();
        for (const part of i.UpdateExpression.replace(/^SET /, '').split(', ')) {
          const [n, v] = part.split(' = ');
          item[names[n]] = vals[v];
        }
        return {};
      }
      throw new Error('unexpected command');
    },
  };
  return { client, commands, items, sent };
}

test('DynamoDB store: conditional put, ordered paginated scan, guarded update', async () => {
  const fake = fakeDynamo();
  const store = createDynamoStore({ client: fake.client, table: 'nctd-passengers-stage', commands: fake.commands });
  const r1 = await store.addNew([
    { 'First Name': 'JANE', 'Last Name': 'DOE', 'MRN Number': '1001', Telephone: '7605550101' },
    { 'First Name': 'JANE-PCA', 'Last Name': 'DOE', 'MRN Number': '1001_PCA', Telephone: '9876543210' },
    { 'First Name': 'ZOE', 'Last Name': 'ABE', 'MRN Number': '0007', Telephone: '7605550107' },
  ], { source: 'CFS_11.16.26.xlsx' });
  assert.equal(r1.saved.length, 3);
  assert.equal(fake.items.get('1001PCA').mrnNumber, '1001_PCA');
  assert.equal(fake.items.get('1001PCA').source, 'CFS_11.16.26.xlsx');
  const r2 = await store.addNew([{ 'First Name': 'X', 'Last Name': 'Y', 'MRN Number': '1001', Telephone: '1' }]);
  assert.deepEqual([r2.saved.length, r2.existed.length], [0, 1]);
  assert.equal(fake.items.get('1001').firstName, 'JANE');
  const list = await store.list();
  assert.deepEqual(list.map((r) => r['MRN Number']), ['1001', '1001_PCA', '0007']);
  assert.ok(fake.sent.filter((c) => c instanceof fake.commands.ScanCommand).length >= 2);

  const before = list[1];
  const after = { ...before, Telephone: '8584020500' };
  assert.equal((await store.applyChanges([{ before, after }])).updated.length, 1);
  assert.equal(fake.items.get('1001PCA').telephone, '8584020500');
  assert.equal(fake.items.get('1001PCA').firstName, 'JANE-PCA');
  // the item no longer holds `before`: skipped, not overwritten
  const res = await store.applyChanges([{ before, after: { ...before, Telephone: '1112223333' } }]);
  assert.deepEqual([res.updated.length, res.skipped.length], [0, 1]);
  assert.equal(fake.items.get('1001PCA').telephone, '8584020500');
});

test('diffCatalog: new and changed passengers by canonical MRN', () => {
  const before = [{ 'First Name': 'A', 'Last Name': 'B', 'MRN Number': '1_PCA', Telephone: '1' }];
  const after = [{ 'First Name': 'A-PCA', 'Last Name': 'B', 'MRN Number': '1_PCA', Telephone: '1' }, { 'First Name': 'C', 'Last Name': 'D', 'MRN Number': '2', Telephone: '2' }];
  const d = diffCatalog(before, after);
  assert.deepEqual(d.added.map((r) => r['MRN Number']), ['2']);
  assert.equal(d.changed.length, 1);
});
