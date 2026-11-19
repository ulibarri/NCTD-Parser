#!/usr/bin/env node
'use strict';

// One-time migration of a DynamoDB catalog table to the NCTD prefix
// (rules v2.11.0, CATALOG-MRN-PREFIX-MIGRATION-001).
//
//   Dry run (writes nothing):
//     node --env-file=.env scripts/migrate-mrn-prefix.js --table nctd-passengers-stage
//   Apply (backup in backups/, then move every passenger):
//     node --env-file=.env scripts/migrate-mrn-prefix.js --table nctd-passengers-stage --apply
//
// Reads AWS_REGION, CATALOG_TABLE, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
// --table must be the same table as CATALOG_TABLE, so the wrong .env cannot
// touch production by mistake. The IAM user needs Scan, PutItem and DeleteItem.

const fs = require('node:fs');
const path = require('node:path');
const { loadRules } = require('../src/rules');
const { migrateMrnPrefix } = require('../src/catalog-migrations');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1] || '';
}

async function main() {
  const apply = process.argv.includes('--apply');
  const table = arg('--table');
  const envTable = String(process.env.CATALOG_TABLE || '').trim();
  const region = String(process.env.AWS_REGION || '').trim();
  if (!table) throw new Error('Pass --table with the table name (the same one as CATALOG_TABLE).');
  if (table !== envTable) throw new Error(`--table ${table} is not CATALOG_TABLE (${envTable || 'empty'}). Check the .env file you used.`);
  if (!region) throw new Error('AWS_REGION is empty.');
  const rules = loadRules();
  const prefix = rules.field_rules.tobi_mrn && rules.field_rules.tobi_mrn.prefix;
  if (!prefix) throw new Error('The active rules have no field_rules.tobi_mrn.prefix.');

  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const lib = require('@aws-sdk/lib-dynamodb');
  const client = lib.DynamoDBDocumentClient.from(new DynamoDBClient({ region, maxAttempts: 8 }));

  console.log(`Rules ${rules.specification.version} · prefix ${prefix} · table ${table} (${region}) · ${apply ? 'APPLY' : 'dry run'}`);
  let backupFile = null;
  const report = await migrateMrnPrefix({
    client,
    commands: lib,
    table,
    prefix,
    apply,
    beforeWrite: (items) => {
      const dir = path.join(__dirname, '..', 'backups');
      fs.mkdirSync(dir, { recursive: true });
      backupFile = path.join(dir, `${table}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(backupFile, JSON.stringify(items, null, 2));
    },
  });

  console.log(`Items read: ${report.scanned} · passengers: ${report.passengers} · already with ${prefix}: ${report.alreadyPrefixed}`);
  if (backupFile) console.log(`Backup: ${backupFile}`);
  const list = (title, rows, fmt) => {
    if (!rows.length) return;
    console.log(`\n${title} (${rows.length}):`);
    rows.slice(0, 50).forEach((r) => console.log(`  ${fmt(r)}`));
    if (rows.length > 50) console.log(`  … ${rows.length - 50} more`);
  };
  if (apply) {
    list('Moved', report.moved, (r) => `${r.from} -> ${r.to}`);
  } else {
    list('Would move', report.toMove, (r) => `${r.from} -> ${r.to} (MRN Number ${r.mrnNumber})`);
  }
  list(apply ? 'Old item deleted (prefixed item already existed, same data)' : 'Would delete the old item (prefixed item already exists, same data)', report.deletedOnly, (r) => `${r.from} (kept ${r.to})`);
  list('CONFLICT: both kept, review by hand', report.conflicts, (r) => `${r.from} -> ${r.to}: stored ${JSON.stringify(r.stored)} vs old ${JSON.stringify(r.old)}`);
  list('FAILED', report.failed, (r) => `${r.from} -> ${r.to}: ${r.error}`);
  if (!apply) console.log('\nNothing was written. Run again with --apply to migrate.');
  else if (!report.failed.length && !report.conflicts.length) console.log('\nDone. Running it again changes nothing.');
  process.exitCode = report.failed.length || report.conflicts.length ? 1 : 0;
}

main().catch((err) => {
  console.error(`Error: ${err.name && err.name !== 'Error' ? `${err.name}: ` : ''}${err.message}`);
  if (err.name === 'AccessDeniedException') console.error('The IAM user needs dynamodb:Scan, dynamodb:PutItem and dynamodb:DeleteItem on this table.');
  process.exitCode = 1;
});
