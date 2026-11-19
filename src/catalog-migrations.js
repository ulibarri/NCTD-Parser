'use strict';

// v2.11.0 CATALOG-MRN-PREFIX-MIGRATION-001: moves DynamoDB catalog items to
// keys with the Tobi MRN prefix (1365 -> NCTD1365). Used by
// scripts/migrate-mrn-prefix.js; kept here so it can be tested.
//
// Each passenger moves in one transaction: Put the new item only if its key
// does not exist, and Delete the old item only if it is unchanged. Nothing is
// half-moved. The #LEG_ID_V2_SEQ counter and items that already have the
// prefix are not touched, so running it twice changes nothing.

const { keyOf } = require('./parser/pasajeros');
const { withPrefix } = require('./parser/fields');

const SAME = ['firstName', 'lastName', 'telephone'];
const isPassenger = (item) => item && typeof item.mrn === 'string' && item.mrn && !item.mrn.startsWith('#');

async function scanAll(client, ScanCommand, table) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const res = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    items.push(...(res.Items || []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** Condition: the old item still holds what was read. */
function unchanged(item) {
  const names = { '#k': 'mrn' };
  const values = {};
  const conds = ['attribute_exists(#k)'];
  ['mrnNumber', ...SAME].forEach((attr, i) => {
    names[`#a${i}`] = attr;
    if (item[attr] === undefined) {
      conds.push(`attribute_not_exists(#a${i})`);
    } else {
      values[`:v${i}`] = item[attr];
      conds.push(`#a${i} = :v${i}`);
    }
  });
  return {
    ConditionExpression: conds.join(' AND '),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  };
}

/**
 * @param {object} o
 * @param {{ send: Function }} o.client DynamoDB DocumentClient
 * @param {object} o.commands { ScanCommand, TransactWriteCommand, DeleteCommand }
 * @param {string} o.table
 * @param {string} o.prefix e.g. NCTD
 * @param {boolean} [o.apply] false = dry run (nothing is written)
 * @param {Function} [o.beforeWrite] called with every scanned item before the first write (backup)
 */
async function migrateMrnPrefix({ client, commands, table, prefix, apply = false, beforeWrite = null }) {
  if (!prefix) throw new Error('migrateMrnPrefix: no prefix');
  const { ScanCommand, TransactWriteCommand, DeleteCommand } = commands;
  const pfx = keyOf(prefix);
  const items = await scanAll(client, ScanCommand, table);
  const byKey = new Map(items.map((i) => [i.mrn, i]));
  const report = { table, apply, scanned: items.length, passengers: 0, alreadyPrefixed: 0, toMove: [], moved: [], deletedOnly: [], conflicts: [], failed: [] };

  const plan = [];
  for (const item of items) {
    if (!isPassenger(item)) continue;
    report.passengers += 1;
    if (item.mrn.startsWith(pfx)) { report.alreadyPrefixed += 1; continue; }
    const to = pfx + item.mrn;
    const next = { ...item, mrn: to, mrnNumber: withPrefix(item.mrnNumber || item.mrn, prefix) };
    const existing = byKey.get(to);
    if (existing) {
      const same = SAME.every((a) => String(existing[a] ?? '') === String(item[a] ?? ''));
      if (same) plan.push({ kind: 'deleteOnly', item, to });
      else report.conflicts.push({ from: item.mrn, to, stored: SAME.map((a) => existing[a]), old: SAME.map((a) => item[a]) });
      continue;
    }
    report.toMove.push({ from: item.mrn, to, mrnNumber: next.mrnNumber });
    plan.push({ kind: 'move', item, to, next });
  }
  if (!apply) {
    report.deletedOnly = plan.filter((p) => p.kind === 'deleteOnly').map((p) => ({ from: p.item.mrn, to: p.to }));
    return report;
  }
  if (beforeWrite) await beforeWrite(items);

  for (const p of plan) {
    try {
      if (p.kind === 'move') {
        await client.send(new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: table, Item: p.next, ConditionExpression: 'attribute_not_exists(mrn)' } },
            { Delete: { TableName: table, Key: { mrn: p.item.mrn }, ...unchanged(p.item) } },
          ],
        }));
        report.moved.push({ from: p.item.mrn, to: p.to });
      } else {
        await client.send(new DeleteCommand({ TableName: table, Key: { mrn: p.item.mrn }, ...unchanged(p.item) }));
        report.deletedOnly.push({ from: p.item.mrn, to: p.to });
      }
    } catch (err) {
      report.failed.push({ from: p.item.mrn, to: p.to, error: err.name || String(err) });
    }
  }
  return report;
}

module.exports = { migrateMrnPrefix };
