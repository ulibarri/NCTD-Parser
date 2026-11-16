'use strict';

// Passenger master catalog (passenger_catalog / CATALOG-001 in the rules).
//
// The Pasajeros file is the source of truth for First Name, Last Name,
// Tobi MRN and Primary Phone. The first values received for a passenger are
// kept forever, so TOBI never receives the same passenger with different data
// (an "alias"). New passengers, companions included, are appended.
// v2.7.1 (CATALOG-NAME-MIGRATION-003, replaces the v2.3.0 migration):
// companion rows (MRN ending in PCA or COM) get the v2.7.0 names: First Name
// ends with -PCA or -COM exactly once and Last Name loses a trailing COMPANION,
// PCA or COM. Client rows are not touched. The migration is idempotent.
// v2.8.2 (CATALOG-PHONE-MIGRATION-001): a Telephone equal to the old fallback
// 9876543210 becomes the current Primary Phone default, 8584020500.

const F = require('./fields');

const PASAJEROS_COLUMNS = ['First Name', 'Last Name', 'MRN Number', 'Telephone'];

/** Catalog key: letters and digits only, case-insensitive (82475_PCA == 82475PCA). */
const keyOf = (v) => F.alnum(v).toUpperCase();

/**
 * Applies the catalog to the Output rows and builds the updated catalog.
 * Output rows are modified in place (First Name, Last Name, Primary Phone).
 *
 * @param {{ headers: string[], columns: string[], rows: object[] } | null} catalog uploaded Pasajeros table
 * @param {object[]} destinationRows Output rows
 * @param {(row: object) => number} sourceRowOf source row number of an Output row
 * @param {object} rules
 */
function applyCatalog(catalog, destinationRows, sourceRowOf, rules) {
  const exceptions = [];
  const headers = catalog ? catalog.headers : PASAJEROS_COLUMNS;
  const columns = catalog ? catalog.columns : PASAJEROS_COLUMNS;
  const severity = rules.exceptions;

  // Uploaded rows keep their order; companion rows are migrated (CATALOG-NAME-MIGRATION-003).
  const migration = (rules.passenger_catalog.migration_rules || []).find((m) => Array.isArray(m.identity_suffixes));
  const col = (name) => headers[columns.indexOf(name)];
  let migrated = 0;
  let phonesMigrated = 0;
  const phoneMigration = rules.passenger_catalog.phone_migration;
  const legacyPhones = new Set((phoneMigration?.legacy_values || []).map((v) => String(v).replace(/\D/g, '')));
  const phoneDefault = rules.field_rules.phones['Primary Phone'].default;
  const catalogRows = catalog ? catalog.rows.map((r) => ({ ...r, values: { ...r.values } })) : [];
  const rows = catalogRows.map((r) => {
    const out = {};
    headers.forEach((h, i) => { out[h] = r.original[i]; });
    const key = keyOf(r.values['MRN Number']);
    const identitySuffix = migration && migration.identity_suffixes.find((sfx) => key.endsWith(sfx) && key.length > sfx.length);
    if (identitySuffix) {
      const first = migrateFirstName(r.values['First Name'], migration, identitySuffix);
      const last = migrateLastName(r.values['Last Name'], migration);
      if (first !== F.collapse(r.values['First Name']) || last !== F.collapse(r.values['Last Name'])) {
        migrated += 1;
        out[col('First Name')] = first;
        out[col('Last Name')] = last;
      }
      r.values['First Name'] = first;
      r.values['Last Name'] = last;
    }
    const phone = String(r.values.Telephone ?? '').replace(/\D/g, '');
    if (legacyPhones.has(phone) && phone !== phoneDefault && col('Telephone')) {
      phonesMigrated += 1;
      out[col('Telephone')] = phoneDefault;
      r.values.Telephone = phoneDefault;
    }
    return out;
  });

  // Index: first row wins for a repeated MRN Number.
  const index = new Map();
  const duplicates = [];
  const badPhones = [];
  if (catalog) {
    for (const r of catalogRows) {
      const key = keyOf(r.values['MRN Number']);
      if (!key) continue;
      if (index.has(key)) {
        duplicates.push(r.rowNumber);
        continue;
      }
      const phone = String(r.values.Telephone ?? '').replace(/\D/g, '');
      if (!/^[0-9]{10}$/.test(phone)) badPhones.push(r.rowNumber);
      index.set(key, {
        'First Name': F.collapse(r.values['First Name']),
        'Last Name': F.collapse(r.values['Last Name']),
        'Primary Phone': phone,
      });
    }
  } else {
    exceptions.push({ code: 'NO_PASSENGER_CATALOG', severity: severity.NO_PASSENGER_CATALOG, rows: [], count: 1 });
  }
  if (duplicates.length) exceptions.push({ code: 'CATALOG_DUPLICATE_MRN', severity: severity.CATALOG_DUPLICATE_MRN, rows: [], count: duplicates.length, catalogRows: duplicates });
  if (badPhones.length) exceptions.push({ code: 'CATALOG_PHONE_INVALID', severity: severity.CATALOG_PHONE_INVALID, rows: [], count: badPhones.length, catalogRows: badPhones });

  // Walk the Output rows in source order so the first appearance defines a new passenger.
  const ordered = [...destinationRows].sort((a, b) => sourceRowOf(a) - sourceRowOf(b));
  const matched = new Set();
  const added = [];
  for (const d of ordered) {
    const key = keyOf(d['Tobi MRN']);
    if (!key) continue;
    let entry = index.get(key);
    if (entry && !added.some((a) => a.key === key)) matched.add(key);
    if (!entry) {
      entry = { 'First Name': d['First Name'], 'Last Name': d['Last Name'], 'Primary Phone': d['Primary Phone'] };
      index.set(key, entry);
      const values = {
        'First Name': d['First Name'],
        'Last Name': d['Last Name'],
        'MRN Number': d['Tobi MRN'],
        Telephone: d['Primary Phone'],
      };
      const out = {};
      headers.forEach((h, i) => { out[h] = values[columns[i]] ?? ''; });
      rows.push(out);
      added.push({ key, ...values });
    }
    d['First Name'] = entry['First Name'];
    d['Last Name'] = entry['Last Name'];
    d['Primary Phone'] = entry['Primary Phone'];
  }

  return { headers, rows, added: added.length, matched: matched.size, migrated, phonesMigrated, provided: Boolean(catalog), exceptions };
}

const flagsOf = (migration) => (migration.case_sensitive ? '' : 'i');

/** First Name with one trailing legacy suffix removed and -PCA / -COM added once. */
function migrateFirstName(value, migration, identitySuffix) {
  const rule = migration['First Name'];
  const base = F.collapse(value).replace(new RegExp(rule.remove_regex, flagsOf(migration)), '').trim();
  return base ? F.appendOnce(base, rule.then_append.replace('{identity_suffix}', identitySuffix)) : base;
}

/** Last Name without one trailing COMPANION, PCA or COM. */
function migrateLastName(value, migration) {
  return F.collapse(value).replace(new RegExp(migration['Last Name'].remove_regex, flagsOf(migration)), '').trim();
}

module.exports = { applyCatalog, PASAJEROS_COLUMNS, keyOf, migrateFirstName, migrateLastName };
