'use strict';

// Persistent passenger master catalog (rules v2.8.3, CATALOG-STORAGE-001).
//
// Without CATALOG_STORE the App works as before: the catalog is the CSV the
// user uploads every day. With CATALOG_STORE=dynamodb the catalog lives in a
// DynamoDB table and the App reads it by itself.
//
// One item per passenger, keyed by the canonical MRN (letters and digits,
// uppercase: 82475PCA). New passengers are written with a conditional put
// (attribute_not_exists), so the first values received always win, even when
// two saves run at the same time. Existing items are only changed by a
// catalog migration (companion names, old phone fallback), and only when the
// item still holds the values the migration was computed from.

const PASAJEROS_COLUMNS = ['First Name', 'Last Name', 'MRN Number', 'Telephone'];
// v2.9.0 LEG-ID-V2-COUNTER-001: last consecutive Leg ID V2 number saved, kept
// in the same table. Passenger keys are letters and digits only, so a key
// that starts with # can never be a passenger.
const COUNTER_KEY = '#LEG_ID_V2_SEQ';
const isPassenger = (item) => item && typeof item.mrn === 'string' && item.mrn && !item.mrn.startsWith('#');
const counterOf = (items) => {
  const c = items.find((i) => i && i.mrn === COUNTER_KEY);
  return c && Number.isInteger(Number(c.last)) ? Number(c.last) : 0;
};
const FIELDS = { 'First Name': 'firstName', 'Last Name': 'lastName', 'MRN Number': 'mrnNumber', Telephone: 'telephone' };

const { keyOf } = require('./parser/pasajeros');

function toItem(row, meta = {}) {
  const item = { mrn: keyOf(row['MRN Number']) };
  for (const [col, attr] of Object.entries(FIELDS)) item[attr] = String(row[col] ?? '');
  if (meta.addedAt) item.addedAt = meta.addedAt;
  if (meta.ord != null) item.ord = meta.ord;
  if (meta.source) item.source = meta.source;
  return item;
}

function toRow(item) {
  const row = {};
  for (const [col, attr] of Object.entries(FIELDS)) row[col] = item[attr] ?? '';
  return row;
}

// Catalog order: the order in which passengers were added (then by MRN).
const byAdded = (a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || ''))
  || (a.ord ?? 0) - (b.ord ?? 0)
  || a.mrn.localeCompare(b.mrn);

/** The catalog as the table readTable() returns for an uploaded CSV. */
function asTable(rows) {
  return {
    headers: [...PASAJEROS_COLUMNS],
    columns: [...PASAJEROS_COLUMNS],
    rows: rows.map((r, i) => ({ rowNumber: i + 2, values: { ...r }, original: PASAJEROS_COLUMNS.map((c) => r[c] ?? '') })),
  };
}

/**
 * Compares the catalog the job was processed with and the updated catalog.
 * @returns {{ added: object[], changed: { before: object, after: object }[] }}
 */
function diffCatalog(before, after) {
  const old = new Map();
  for (const r of before) {
    const k = keyOf(r['MRN Number']);
    if (k && !old.has(k)) old.set(k, r);
  }
  const added = [];
  const changed = [];
  const seen = new Set();
  for (const r of after) {
    const k = keyOf(r['MRN Number']);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const prev = old.get(k);
    if (!prev) added.push(r);
    else if (PASAJEROS_COLUMNS.some((c) => String(prev[c] ?? '') !== String(r[c] ?? ''))) changed.push({ before: prev, after: r });
  }
  return { added, changed };
}

/**
 * Store over a DynamoDB DocumentClient-like object (anything with send()).
 * Commands are built by `commands` so tests can pass a fake client.
 */
function createDynamoStore({ client, table, commands }) {
  const { ScanCommand, PutCommand, UpdateCommand } = commands;
  const isConditionFailure = (err) => err && (err.name === 'ConditionalCheckFailedException' || err.__type === 'ConditionalCheckFailedException');

  async function scanAll() {
    const items = [];
    let ExclusiveStartKey;
    do {
      const res = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
      items.push(...(res.Items || []));
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  return {
    kind: 'dynamodb',
    table,

    /** Passengers in catalog order and the last Leg ID V2 number saved (0 = none). */
    async snapshot() {
      const items = await scanAll();
      return { rows: items.filter(isPassenger).sort(byAdded).map(toRow), legIdV2Last: counterOf(items) };
    },

    async list() {
      return (await this.snapshot()).rows;
    },

    /**
     * Saves the last number of a consecutive Leg ID V2 range. Refused when a
     * number of the range was already saved (stored last >= first).
     */
    async recordLegIdV2({ first, last, source }) {
      try {
        await client.send(new UpdateCommand({
          TableName: table,
          Key: { mrn: COUNTER_KEY },
          UpdateExpression: 'SET #last = :last, #updatedAt = :now, #source = :source',
          ConditionExpression: 'attribute_not_exists(#last) OR #last < :first',
          ExpressionAttributeNames: { '#last': 'last', '#updatedAt': 'updatedAt', '#source': 'source' },
          ExpressionAttributeValues: { ':last': last, ':first': first, ':now': new Date().toISOString(), ':source': String(source || '') },
        }));
        return { recorded: true };
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        return { recorded: false };
      }
    },

    /** Conditional put: a passenger that already exists is never overwritten. */
    async addNew(rows, { source } = {}) {
      const addedAt = new Date().toISOString();
      const saved = [];
      const existed = [];
      for (const [ord, row] of rows.entries()) {
        const item = toItem(row, { addedAt, ord, source });
        if (!item.mrn) continue;
        try {
          await client.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(mrn)' }));
          saved.push(row);
        } catch (err) {
          if (!isConditionFailure(err)) throw err;
          existed.push(row);
        }
      }
      return { saved, existed };
    },

    /** Migration of an existing passenger, only if the item still holds `before`. */
    async applyChanges(changes) {
      const updated = [];
      const skipped = [];
      for (const { before, after } of changes) {
        const names = {};
        const values = {};
        const sets = [];
        const conds = ['attribute_exists(mrn)'];
        Object.entries(FIELDS).forEach(([col, attr], i) => {
          names[`#f${i}`] = attr;
          values[`:old${i}`] = String(before[col] ?? '');
          conds.push(`#f${i} = :old${i}`);
          if (String(before[col] ?? '') !== String(after[col] ?? '')) {
            values[`:new${i}`] = String(after[col] ?? '');
            sets.push(`#f${i} = :new${i}`);
          }
        });
        if (!sets.length) continue;
        try {
          await client.send(new UpdateCommand({
            TableName: table,
            Key: { mrn: keyOf(before['MRN Number']) },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: conds.join(' AND '),
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }));
          updated.push(after);
        } catch (err) {
          if (!isConditionFailure(err)) throw err;
          skipped.push(after);
        }
      }
      return { updated, skipped };
    },
  };
}

/** In-memory store with the same behavior, for tests and local trials. */
function createMemoryStore({ table = 'memory', items = [] } = {}) {
  const data = new Map(items.map((i) => [i.mrn, { ...i }]));
  let last = 0;
  return {
    kind: 'memory',
    table,
    data,
    async snapshot() {
      const items = [...data.values()];
      return { rows: items.filter(isPassenger).sort(byAdded).map(toRow), legIdV2Last: counterOf(items) };
    },
    async list() {
      return (await this.snapshot()).rows;
    },
    async recordLegIdV2({ first, last, source }) {
      const stored = counterOf([data.get(COUNTER_KEY)]);
      if (data.has(COUNTER_KEY) && !(stored < first)) return { recorded: false };
      data.set(COUNTER_KEY, { mrn: COUNTER_KEY, last, updatedAt: new Date().toISOString(), source: String(source || '') });
      return { recorded: true };
    },
    async addNew(rows, { source } = {}) {
      last = Math.max(Date.now(), last + 1); // strictly increasing, like separate saves
      const addedAt = new Date(last).toISOString();
      const saved = [];
      const existed = [];
      rows.forEach((row, ord) => {
        const item = toItem(row, { addedAt, ord, source });
        if (!item.mrn) return;
        if (data.has(item.mrn)) existed.push(row);
        else { data.set(item.mrn, item); saved.push(row); }
      });
      return { saved, existed };
    },
    async applyChanges(changes) {
      const updated = [];
      const skipped = [];
      for (const { before, after } of changes) {
        const item = data.get(keyOf(before['MRN Number']));
        const same = item && Object.entries(FIELDS).every(([col, attr]) => String(item[attr] ?? '') === String(before[col] ?? ''));
        if (!same) { skipped.push(after); continue; }
        for (const [col, attr] of Object.entries(FIELDS)) item[attr] = String(after[col] ?? '');
        updated.push(after);
      }
      return { updated, skipped };
    },
  };
}

/**
 * Store chosen by the environment, or null (CSV mode).
 *   CATALOG_STORE=dynamodb, CATALOG_TABLE, AWS_REGION, CATALOG_ACCESS_KEY
 *   (CATALOG_STORE=memory: same rules, nothing persisted; for local trials)
 *   (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are read by the AWS SDK).
 */
function storeFromEnv(env = process.env) {
  const kind = String(env.CATALOG_STORE || '').trim().toLowerCase();
  if (!kind || kind === 'csv') return null;
  if (kind !== 'dynamodb' && kind !== 'memory') throw new Error(`CATALOG_STORE=${kind} is not supported (use dynamodb, memory or leave it empty)`);
  const table = String(env.CATALOG_TABLE || '').trim();
  if (!table) throw new Error(`CATALOG_STORE=${kind} needs CATALOG_TABLE`);
  if (!String(env.CATALOG_ACCESS_KEY || '').trim()) throw new Error(`CATALOG_STORE=${kind} needs CATALOG_ACCESS_KEY, so the public URL cannot read or change the catalog`);
  // memory: same behavior without AWS, lost on restart (local trials only)
  if (kind === 'memory') return createMemoryStore({ table });
  if (!String(env.AWS_REGION || '').trim()) throw new Error('CATALOG_STORE=dynamodb needs AWS_REGION');
  // Loaded only in database mode.
  // eslint-disable-next-line global-require
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  // eslint-disable-next-line global-require
  const lib = require('@aws-sdk/lib-dynamodb');
  const client = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.AWS_REGION, maxAttempts: 8 }));
  return createDynamoStore({ client, table, commands: lib });
}

module.exports = { COUNTER_KEY, storeFromEnv, createDynamoStore, createMemoryStore, diffCatalog, asTable, keyOf, PASAJEROS_COLUMNS };
