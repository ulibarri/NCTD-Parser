'use strict';

// Test helpers: synthetic Viajes rows (no real passenger data).

const { loadRules } = require('../src/rules');
const { processViajes } = require('../src/parser/pipeline');

const rules = loadRules();

const BASE = {
  'Client Name': 'DOE ,JANE',
  'Client ID': '1001',
  TripDate: '10/23/2026',
  PUTime: '07:55:00',
  PUAddress: '100 MAIN ST',
  PUCity: 'OCEANSIDE',
  PUZipcode: '92054',
  DOAddress: '200 MISSION AVE STE 5',
  DOCity: 'VISTA',
  DOZipcode: '92081',
  DNLA: ' ',
  MapQMiles: '4.5',
  Assisted: '  ',
  PickUpLocationName: '',
  DropLocationName: 'DIALYSIS - VISTA',
  'Passenger Ty': 'CLI',
  'Space Type': 'AM',
  Amount: '5',
  DOAppt: '09:30:00',
  Comments: '',
  NoClients: '1',
  PULat: '33000000',
  PULon: '-117000000',
  DOLat: '33100000',
  DOLon: '-117100000',
  Subtype: 'SUB',
  FareType: '0',
  CashTck: '',
  'Run Name': 'SOL',
};

function row(overrides = {}) {
  return { ...BASE, ...overrides };
}

/** Return leg of a row: pickup and dropoff swapped, later time. */
function returnOf(r, overrides = {}) {
  return row({
    ...r,
    PUAddress: r.DOAddress, PUCity: r.DOCity, PUZipcode: r.DOZipcode,
    DOAddress: r.PUAddress, DOCity: r.PUCity, DOZipcode: r.PUZipcode,
    PickUpLocationName: r.DropLocationName, DropLocationName: r.PickUpLocationName,
    PUTime: '15:00:00', DOAppt: '',
    ...overrides,
  });
}

function table(rows) {
  const headers = rules.source_columns;
  return {
    headers,
    columns: headers,
    rows: rows.map((values, i) => ({ rowNumber: i + 2, values: { ...values }, original: headers.map((h) => values[h] ?? '') })),
  };
}

/** Passenger catalog table (Pasajeros CSV) from plain objects. */
function catalog(rows, headers = ['First Name', 'Last Name', 'MRN Number', 'Telephone']) {
  return {
    headers,
    columns: headers,
    rows: rows.map((values, i) => ({ rowNumber: i + 2, values: { ...values }, original: headers.map((h) => values[h] ?? '') })),
  };
}

async function run(rows, { overrideDate = null, catalog: cat = null, legIdV2Mode = false, legIdV2Sequence = null } = {}) {
  return processViajes({ table: table(rows), rules, overrideDate, catalog: cat, legIdV2Mode, legIdV2Sequence });
}

module.exports = { rules, row, returnOf, table, catalog, run, BASE };
