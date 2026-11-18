'use strict';

// v2.9.0: CATALOG-REMEMBER-DEVICE-001 (AT-70 to AT-72) and
// LEG-ID-V2-COUNTER-001 (AT-73 to AT-75).

const test = require('node:test');
const assert = require('node:assert/strict');
const { stringify } = require('csv-stringify/sync');
const { rules, row } = require('./helpers');
const { createApp } = require('../server');
const { createMemoryStore, createDynamoStore, COUNTER_KEY } = require('../src/catalog-store');
const session = require('../src/catalog-session');

const KEY = 'clave-de-prueba';
const viajesCsv = (rows) => stringify([rules.source_columns, ...rows.map((r) => rules.source_columns.map((c) => r[c] ?? ''))]);
const trips = (n) => Array.from({ length: n }, (_, i) => row({ 'Client ID': String(5000 + i), 'Client Name': `PEREZ,ANA${String.fromCharCode(65 + (i % 26))}` }));

async function withApp(store, fn, { accessKey = KEY } = {}) {
  const server = createApp({ rules, catalogStore: store, accessKey }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const jar = { cookie: '' };
  const call = async (path, { method = 'GET', key, json, file, headers = {}, cookie = jar.cookie } = {}) => {
    const h = { ...headers };
    if (key !== undefined) h['X-Catalog-Key'] = key;
    if (cookie) h.Cookie = cookie;
    let body;
    if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (file) { body = new FormData(); body.append('file', new Blob([file.content], { type: 'text/csv' }), file.name); }
    const res = await fetch(base + path, { method, headers: h, body });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* CSV */ }
    return { status: res.status, data, setCookie: res.headers.get('set-cookie') };
  };
  const login = async (key = KEY, headers = {}) => {
    const r = await call('/catalog/session', { method: 'POST', json: { key }, headers, cookie: '' });
    if (r.setCookie) jar.cookie = r.setCookie.split(';')[0];
    return r;
  };
  const process = async (rows, extra = {}) => {
    const up = await call('/uploads/viajes', { method: 'POST', file: { name: 'CFS_11.17.26.csv', content: viajesCsv(rows) } });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    return call('/jobs', { method: 'POST', json: { viajesUploadId: up.data.uploadId, ...extra } });
  };
  try {
    await fn({ call, login, process, jar });
  } finally {
    server.close();
  }
}

const seq = (start) => ({ legIdV2Sequential: true, legIdV2Start: String(start) });

test('rules: v2.9.0 remember device and Leg ID V2 counter', () => {
  assert.ok(rules.specification.changelog.some((c) => c.version === '2.9.0'));
  const access = rules.passenger_catalog.storage.access;
  assert.equal(access.remember_device_days, 60);
  assert.equal(access.max_failed_attempts, 5);
  assert.equal(access.key.includes('CATALOG_ACCESS_KEY'), true); // v2.8.3 keys kept by the deep merge
  assert.equal(rules.experimental_rules.leg_id_v2_counter.rule_id, 'LEG-ID-V2-COUNTER-001');
  assert.ok(rules.experimental_rules.leg_id_v2, 'v2.6.0 Leg ID V2 rule kept');
  assert.match(rules.passenger_catalog.storage.write.trigger, /Save result/);
  assert.ok(rules.passenger_catalog.storage.write.new_passenger, 'v2.8.3 write rules kept');
});

test('AT-70 the key typed once remembers the computer for 60 days', async () => {
  await withApp(createMemoryStore(), async ({ call, login }) => {
    assert.equal((await call('/catalog/status')).data.remembered, false);
    assert.equal((await call('/catalog')).status, 401);
    const r = await login(KEY, { 'X-Forwarded-Proto': 'https' });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /^nctd_catalog=\d+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=5184000; HttpOnly; SameSite=Strict; Secure$/);
    assert.ok(!r.setCookie.includes(KEY));
    const until = Date.parse(r.data.rememberedUntil);
    assert.ok(Math.abs(until - (Date.now() + 60 * 86400000)) < 60000);
    const status = await call('/catalog/status');
    assert.equal(status.data.remembered, true);
    assert.equal(status.data.rememberedUntil, r.data.rememberedUntil);
    assert.equal((await call('/catalog')).status, 200);
    // the header still works (API use, tests)
    assert.equal((await call('/catalog', { key: KEY, cookie: '' })).status, 200);
  });
  // plain HTTP (localhost): no Secure flag, so the browser keeps the cookie
  await withApp(createMemoryStore(), async ({ login }) => {
    assert.doesNotMatch((await login()).setCookie, /Secure/);
  });
});

test('AT-71 changed key, tampered or expired cookie, forget this computer', async () => {
  let cookie;
  await withApp(createMemoryStore(), async ({ login, jar }) => {
    await login();
    cookie = jar.cookie;
  });
  // same cookie after the key changed in Render
  await withApp(createMemoryStore(), async ({ call }) => {
    assert.equal((await call('/catalog', { cookie })).status, 401);
    assert.equal((await call('/catalog/status', { cookie })).data.remembered, false);
  }, { accessKey: 'otra-clave' });
  await withApp(createMemoryStore(), async ({ call, login, jar }) => {
    const token = cookie.split('=')[1];
    const [exp, sig] = token.split('.');
    assert.equal((await call('/catalog', { cookie: `nctd_catalog=${Number(exp) + 1}.${sig}` })).status, 401);
    const expired = session.createToken(KEY, -1).token;
    assert.equal((await call('/catalog', { cookie: `nctd_catalog=${expired}` })).status, 401);
    await login();
    assert.equal((await call('/catalog')).status, 200);
    const out = await call('/catalog/session', { method: 'DELETE' });
    assert.match(out.setCookie, /^nctd_catalog=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict$/);
    jar.cookie = '';
    assert.equal((await call('/catalog')).status, 401);
  });
});

test('AT-72 five wrong keys block the client for a while', async () => {
  await withApp(createMemoryStore(), async ({ call, login }) => {
    for (let i = 0; i < 5; i += 1) assert.equal((await login('NCTD2025')).status, 401);
    const r = await login(KEY);
    assert.deepEqual([r.status, r.data.error], [429, 'CATALOG_TOO_MANY_ATTEMPTS']);
    assert.equal((await call('/catalog', { key: KEY })).status, 429);
  });
  const lim = session.createAttemptLimiter({ max: 2, windowMs: 1000 });
  lim.fail('a', 0);
  lim.fail('a', 10);
  assert.equal(lim.blocked('a', 20), true);
  assert.equal(lim.blocked('a', 1011), false);
  assert.equal(lim.blocked('b', 20), false);
});

test('AT-73 the counter starts at L000001 and moves when the result is saved', async () => {
  const store = createMemoryStore();
  await withApp(store, async ({ call, login, process }) => {
    await login();
    assert.deepEqual((await call('/catalog')).data.legIdV2, { last: 0, lastLabel: null, next: 1, nextLabel: 'L000001' });
    const r = await process(trips(3), seq(1));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.rows.map((d) => d['Leg ID V2']), ['L000001', 'L000002', 'L000003']);
    assert.deepEqual(r.data.summary.catalogPending.legIdV2, { first: 'L000001', last: 'L000003', overlaps: false, storedLast: 0 });
    const saved = await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    assert.deepEqual(saved.data.legIdV2, { recorded: true, first: 'L000001', last: 'L000003', nextLabel: 'L000004' });
    assert.equal(saved.data.stale, false);
    assert.equal(saved.data.saved, 3);
    const cat = await call('/catalog');
    assert.equal(cat.data.legIdV2.nextLabel, 'L000004');
    assert.equal(cat.data.rowCount, 3, 'the counter is not a passenger');
    assert.ok(!cat.data.rows.some((p) => p['MRN Number'].startsWith('#')));
    assert.ok(!(await call('/catalog/export')).data.includes('#LEG'));
    assert.equal(store.data.get(COUNTER_KEY).last, 3);
    // a result with no new passengers but a range still has something to save
    const again = await process(trips(2), seq(4));
    assert.deepEqual(again.data.summary.catalogPending, { added: 0, changed: 0, legIdV2: { first: 'L000004', last: 'L000005', overlaps: false, storedLast: 3 } });
    // without the option nothing is pending for the counter
    assert.equal((await process(trips(1))).data.summary.catalogPending.legIdV2, null);
  });
});

test('AT-74 processing does not use numbers; saving twice writes once', async () => {
  const store = createMemoryStore();
  await withApp(store, async ({ call, login, process }) => {
    await login();
    await process(trips(4), seq(1));
    await process(trips(4), seq(1));
    assert.equal((await call('/catalog')).data.legIdV2.next, 1);
    const r = await process(trips(4), seq(1));
    await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    const twice = await call(`/jobs/${r.data.jobId}/catalog`, { method: 'POST' });
    assert.equal(twice.data.alreadySaved, true);
    assert.equal(store.data.get(COUNTER_KEY).last, 4);
  });
});

test('AT-75 overlapping ranges: the first saved wins, the other is stale', async () => {
  const store = createMemoryStore();
  await withApp(store, async ({ call, login, process }) => {
    await login();
    const a = await process(trips(5), seq(1));
    const b = await process(trips(3), seq(1));
    assert.equal((await call(`/jobs/${b.data.jobId}/catalog`, { method: 'POST' })).data.legIdV2.recorded, true);
    const late = await call(`/jobs/${a.data.jobId}/catalog`, { method: 'POST' });
    assert.equal(late.data.stale, true);
    assert.deepEqual(late.data.legIdV2, { recorded: false, first: 'L000001', last: 'L000005', nextLabel: 'L000004', storedLast: 'L000003' });
    assert.equal(store.data.get(COUNTER_KEY).last, 3);
    // processed again from the suggested number: it is saved
    const c = await process(trips(5), seq(4));
    assert.equal(c.data.summary.catalogPending.legIdV2.overlaps, false);
    assert.equal((await call(`/jobs/${c.data.jobId}/catalog`, { method: 'POST' })).data.legIdV2.recorded, true);
    assert.equal(store.data.get(COUNTER_KEY).last, 8);
    // a start inside a saved range is flagged before saving
    const d = await process(trips(2), seq(2));
    assert.equal(d.data.summary.catalogPending.legIdV2.overlaps, true);
  });
});

test('DynamoDB store: counter update condition and snapshot', async () => {
  const items = new Map();
  class Cmd { constructor(input) { this.input = input; } }
  const commands = { ScanCommand: class extends Cmd {}, PutCommand: class extends Cmd {}, UpdateCommand: class extends Cmd {} };
  const fail = () => Object.assign(new Error('failed'), { name: 'ConditionalCheckFailedException' });
  const client = {
    async send(cmd) {
      const i = cmd.input;
      if (cmd instanceof commands.ScanCommand) return { Items: [...items.values()] };
      if (cmd instanceof commands.PutCommand) { items.set(i.Item.mrn, { ...i.Item }); return {}; }
      assert.equal(i.ConditionExpression, 'attribute_not_exists(#last) OR #last < :first');
      const cur = items.get(i.Key.mrn);
      if (cur && !(cur.last < i.ExpressionAttributeValues[':first'])) throw fail();
      items.set(i.Key.mrn, { mrn: i.Key.mrn, last: i.ExpressionAttributeValues[':last'], source: i.ExpressionAttributeValues[':source'] });
      return {};
    },
  };
  const store = createDynamoStore({ client, table: 't', commands });
  await store.addNew([{ 'First Name': 'A', 'Last Name': 'B', 'MRN Number': '1', Telephone: '1' }]);
  assert.deepEqual(await store.snapshot(), { rows: [{ 'First Name': 'A', 'Last Name': 'B', 'MRN Number': '1', Telephone: '1' }], legIdV2Last: 0 });
  assert.deepEqual(await store.recordLegIdV2({ first: 1, last: 10, source: 'x' }), { recorded: true });
  assert.deepEqual(await store.recordLegIdV2({ first: 10, last: 12 }), { recorded: false });
  assert.deepEqual(await store.recordLegIdV2({ first: 11, last: 12 }), { recorded: true });
  const snap = await store.snapshot();
  assert.equal(snap.legIdV2Last, 12);
  assert.equal(snap.rows.length, 1);
});
