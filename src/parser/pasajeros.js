'use strict';

// Pasajeros update.
// PROVISIONAL: the rules for updating Pasajeros have not been defined yet.
// Until they are, this module appends one row per client (Passenger Ty = CLI)
// whose Client ID is not already in "MRN Number". Everything about the
// update lives here so it can be replaced when the rules arrive.

const F = require('./fields');

const PASAJEROS_COLUMNS = ['First Name', 'Last Name', 'MRN Number', 'Telephone'];

const normId = (v) => F.collapse(v).replace(/\.0+$/, '').toUpperCase();

/**
 * @param {{ headers: string[], columns: string[], rows: object[] } | null} pasajeros
 * @param {object[]} destinationRows Output rows
 * @param {string} defaultPhone value used when no phone was found
 */
function updatePasajeros(pasajeros, destinationRows, defaultPhone) {
  const headers = pasajeros ? pasajeros.headers : PASAJEROS_COLUMNS;
  const columns = pasajeros ? pasajeros.columns : PASAJEROS_COLUMNS;
  const rows = pasajeros ? pasajeros.rows.map((r) => {
    const out = {};
    headers.forEach((h, i) => { out[h] = r.original[i]; });
    return out;
  }) : [];

  const known = new Set(pasajeros ? pasajeros.rows.map((r) => normId(r.values['MRN Number'])) : []);
  const added = [];
  for (const d of destinationRows) {
    if (/_PCA$/i.test(d['Tobi MRN']) || / - PCA$/i.test(d['First Name'])) continue; // clients only
    const id = normId(d['Tobi MRN']);
    if (!id || known.has(id)) continue;
    known.add(id);
    const values = {
      'First Name': d['First Name'],
      'Last Name': d['Last Name'],
      'MRN Number': d['Tobi MRN'],
      Telephone: d['Primary Phone'] === defaultPhone ? '' : d['Primary Phone'],
    };
    const out = {};
    headers.forEach((h, i) => { out[h] = values[columns[i]] ?? ''; });
    rows.push(out);
    added.push(values);
  }
  return { headers, rows, added: added.length };
}

module.exports = { updatePasajeros, PASAJEROS_COLUMNS };
