'use strict';

// Processing pipeline for the Viajes file, following processing_pipeline in
// config/rules/nctd_manifest_parser_rules_v1.3.0.json.

const crypto = require('node:crypto');
const D = require('./dates');
const F = require('./fields');

const ADDITIONAL_INVALID_COLUMNS = ['Source Row Number', 'Validation Status', 'Invalid Fields', 'Validation Errors'];

class ProcessingError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

/** Distinct valid TripDates in a Viajes table, as YYYY-MM-DD keys. */
function distinctTripDates(rows) {
  const set = new Set();
  for (const r of rows) {
    const d = D.parseTripDate(r.values.TripDate);
    if (d) set.add(D.ymdKey(d));
  }
  return [...set].sort();
}

/** Returns the rows with TripDate replaced (for the date-change preview). */
function applyTripDateOverride(rows, newDate) {
  return rows.map((r) => {
    if (!D.parseTripDate(r.values.TripDate)) return r;
    return { ...r, values: { ...r.values, TripDate: D.formatDisplayDate(newDate) } };
  });
}

function validateRow(values, rules) {
  const v = rules.required_field_validation;
  const markers = v.missing_markers_case_insensitive;
  const invalidFields = [];
  const errors = [];
  for (const field of v.fields) {
    const value = values[field];
    if (F.isMissing(value, markers)) {
      invalidFields.push(field);
      errors.push(`${field}: missing value`);
      continue;
    }
    const format = v.format_rules[field];
    if (!format) continue;
    let ok = true;
    if (field === 'TripDate') ok = Boolean(D.parseTripDate(value));
    else if (field === 'PUTime') ok = Boolean(D.parseTime(value));
    else if (typeof format === 'string') ok = new RegExp(format).test(F.collapse(value));
    if (!ok) {
      invalidFields.push(field);
      errors.push(`${field}: invalid format`);
    }
  }
  return { invalidFields, errors };
}

function locationId(loc) {
  return [loc.street, loc.suite, loc.city, loc.zip].map(F.upper).join('|');
}

/**
 * Processes a Viajes table.
 * @param {object} p
 * @param {{ columns: string[], headers: string[], rows: object[] }} p.table
 * @param {object} p.rules
 * @param {{y:number,m:number,d:number}|null} p.overrideDate
 * @param {import('../registry/json-registry').JsonRegistry} p.registry
 * @param {Date} [p.now]
 */
async function processViajes({ table, rules, overrideDate = null, registry, now = new Date() }) {
  const fr = rules.field_rules;
  const jl = rules.journey_leg_rules;
  const severity = rules.exceptions;
  const exceptions = []; // { code, severity, rows: number[] }
  const addException = (code, rowNumbers) => {
    exceptions.push({ code, severity: severity[code] || 'error', rows: [...rowNumbers].sort((a, b) => a - b) });
  };

  // read_source + preserve_original_rows
  const sourceRows = table.rows;
  const originalDates = distinctTripDates(sourceRows);

  // apply_trip_date_override
  if (overrideDate) {
    if (originalDates.length > 1) {
      throw new ProcessingError('MULTIPLE_TRIP_DATES', { dates: originalDates });
    }
  }

  // validate_required_fields + route_invalid_rows
  const invalid = []; // { row, status, invalidFields, errors }
  const valid = [];
  for (const row of sourceRows) {
    const { invalidFields, errors } = validateRow(row.values, rules);
    if (invalidFields.length) invalid.push({ row, status: rules.required_field_validation.invalid_action.status, invalidFields, errors });
    else valid.push(row);
  }

  // normalize_valid_rows
  const collapseFields = new Set(rules.normalization.collapse_whitespace_fields);
  const normalized = valid.map((row) => {
    const values = {};
    for (const [k, v] of Object.entries(row.values)) {
      values[k] = collapseFields.has(k) ? F.collapse(v) : String(v ?? '').trim();
    }
    const date = overrideDate || D.parseTripDate(values.TripDate);
    const puTime = D.parseTime(values.PUTime);
    const doTime = D.parseTime(values.DOAppt);
    const pu = F.splitAddress(values.PUAddress, fr.pickup_address.secondary_indicators);
    const dropoff = F.splitAddress(values.DOAddress, fr.dropoff_address.secondary_indicators);
    return {
      row,
      values,
      clientId: F.collapse(values['Client ID']),
      passengerType: F.upper(values['Passenger Ty']),
      date,
      puTime,
      doTime,
      pickup: { street: pu.street, suite: pu.suite, city: values.PUCity, zip: values.PUZipcode },
      dropoff: { street: dropoff.street, suite: dropoff.suite, city: values.DOCity, zip: values.DOZipcode },
    };
  });

  // remove_exact_duplicates (every normalized Source column identical)
  const seen = new Map();
  const unique = [];
  const duplicateRows = [];
  for (const n of normalized) {
    const key = JSON.stringify(table.columns.map((c) => (c === 'TripDate' ? D.ymdKey(n.date) : n.values[c])));
    if (seen.has(key)) duplicateRows.push(n.row.rowNumber);
    else {
      seen.set(key, n);
      unique.push(n);
    }
  }
  if (duplicateRows.length) addException(rules.exact_duplicate_rule.code, duplicateRows);

  // classify_passengers
  const exceptionRows = new Map(); // rowNumber -> [codes]
  const markException = (code, items) => {
    addException(code, items.map((n) => n.row.rowNumber));
    for (const n of items) {
      const list = exceptionRows.get(n.row.rowNumber) || [];
      list.push(code);
      exceptionRows.set(n.row.rowNumber, list);
    }
  };
  const classified = [];
  const unknownType = [];
  for (const n of unique) {
    const t = rules.passenger_types[n.passengerType];
    if (!t) unknownType.push(n);
    else classified.push({ ...n, classification: t.classification });
  }
  if (unknownType.length) markException('UNKNOWN_PASSENGER_TYPE', unknownType);

  // create_leg_groups + associate_assistants
  const groups = new Map();
  for (const n of classified) {
    const keyParts = jl.leg_group_key.map((field) => {
      if (field === 'TripDate') return D.ymdKey(n.date);
      if (field === 'PUTime') return D.timeKey(n.puTime);
      if (field === 'Client ID') return n.clientId;
      return F.upper(n.values[field]);
    });
    const key = keyParts.join('␟');
    if (!groups.has(key)) {
      groups.set(key, { key, clientId: n.clientId, date: n.date, puTime: n.puTime, pickup: n.pickup, dropoff: n.dropoff, clients: [], assistants: [] });
    }
    const g = groups.get(key);
    (n.classification === 'client' ? g.clients : g.assistants).push(n);
  }
  const legs = [];
  const aa = jl.assistant_association;
  for (const g of groups.values()) {
    const all = [...g.clients, ...g.assistants];
    if (g.clients.length === 0) markException(aa.orphan_exception, all);
    else if (g.clients.length > 1) markException(aa.multiple_cli_exception, all);
    else if (g.assistants.length > 1) markException('MULTIPLE_ASSISTANTS_SAME_LEG', all);
    else legs.push(g);
  }

  // detect_journeys + assign_leg_sequence
  const partitions = new Map();
  for (const leg of legs) {
    const k = `${leg.clientId}␟${D.ymdKey(leg.date)}`;
    if (!partitions.has(k)) partitions.set(k, []);
    partitions.get(k).push(leg);
  }
  const journeys = []; // { clientId, date, legs: [{ seq, leg }] }
  let nonReciprocal = 0;
  for (const partLegs of partitions.values()) {
    partLegs.sort((a, b) => D.timeKey(a.puTime).localeCompare(D.timeKey(b.puTime)));
    const assigned = new Set();
    const rejected = new Set();
    const reciprocal = (a, b) => locationId(a.pickup) === locationId(b.dropoff) && locationId(a.dropoff) === locationId(b.pickup);
    for (let i = 0; i < partLegs.length; i += 1) {
      const a = partLegs[i];
      if (assigned.has(a) || rejected.has(a)) continue;
      const sameTime = partLegs.filter((b) => b !== a && !assigned.has(b) && !rejected.has(b)
        && D.timeKey(b.puTime) === D.timeKey(a.puTime) && reciprocal(a, b));
      if (sameTime.length) {
        const bad = [a, ...sameTime];
        bad.forEach((l) => rejected.add(l));
        markException('INVALID_LEG_SEQUENCE', bad.flatMap((l) => [...l.clients, ...l.assistants]));
        continue;
      }
      const candidates = partLegs.slice(i + 1).filter((b) => !assigned.has(b) && !rejected.has(b)
        && D.timeKey(b.puTime) > D.timeKey(a.puTime) && reciprocal(a, b));
      if (candidates.length > 1) {
        const bad = [a, ...candidates];
        bad.forEach((l) => rejected.add(l));
        markException('MULTIPLE_RETURN_LEGS', bad.flatMap((l) => [...l.clients, ...l.assistants]));
        continue;
      }
      assigned.add(a);
      if (candidates.length === 1) {
        assigned.add(candidates[0]);
        journeys.push({ clientId: a.clientId, date: a.date, legs: [{ seq: jl.leg_sequence.two_leg_earlier, leg: a }, { seq: jl.leg_sequence.two_leg_later, leg: candidates[0] }] });
      } else {
        if (partLegs.length > 1) nonReciprocal += 1;
        journeys.push({ clientId: a.clientId, date: a.date, legs: [{ seq: jl.leg_sequence.single_leg, leg: a }] });
      }
    }
  }
  if (nonReciprocal) exceptions.push({ code: 'NONRECIPROCAL_ROUTE', severity: severity.NONRECIPROCAL_ROUTE, rows: [], count: nonReciprocal });

  // reuse_or_generate_journey_id + generate_leg_id
  journeys.sort((x, y) => D.ymdKey(x.date).localeCompare(D.ymdKey(y.date))
    || D.timeKey(x.legs[0].leg.puTime).localeCompare(D.timeKey(y.legs[0].leg.puTime))
    || x.clientId.localeCompare(y.clientId, 'en', { numeric: true }));

  const jid = jl.journey_id;
  const journeyRe = new RegExp(rules.validation_patterns['Journey ID']);
  const legRe = new RegExp(rules.validation_patterns['Leg ID']);
  let reusedCount = 0;
  await registry.transaction((session) => {
    for (const j of journeys) {
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify([
        j.clientId,
        D.ymdKey(j.date),
        ...j.legs.map(({ seq, leg }) => [seq, D.timeKey(leg.puTime), locationId(leg.pickup), locationId(leg.dropoff)]),
      ])).digest('hex');
      const res = session.allocate(D.yymmdd(j.date), fingerprint);
      if (res.error) {
        j.error = res.error;
        continue;
      }
      j.journeyId = res.journeyId;
      if (res.reused) reusedCount += 1;
    }
  }, { now, maximumPerDay: jid.maximum_per_day, width: jid.width });

  // map_destination_fields + validate_destination
  const destinationRows = [];
  const unknownSpaceTypes = new Set();
  for (const j of journeys) {
    const rowsOf = j.legs.flatMap(({ leg }) => [...leg.clients, ...leg.assistants]);
    if (j.error || !journeyRe.test(j.journeyId)) {
      markException('INVALID_JOURNEY_ID', rowsOf);
      continue;
    }
    const mapped = [];
    let legError = false;
    for (const { seq, leg } of j.legs) {
      const legId = `${j.clientId}_${j.journeyId}_${seq}`;
      if (!legRe.test(legId)) legError = true;
      for (const n of [...leg.clients, ...leg.assistants]) {
        mapped.push(mapRow(n, j.journeyId, legId, rules, unknownSpaceTypes));
      }
    }
    if (legError) {
      markException('INVALID_LEG_ID', rowsOf);
      continue;
    }
    destinationRows.push(...mapped);
  }

  // Invalid Trips: invalid rows + rows with error-level exceptions
  const exceptionStatus = 'EXCEPTION';
  const invalidTrips = [
    ...invalid.map((x) => ({ row: x.row, status: x.status, fields: x.invalidFields, errors: x.errors })),
    ...[...exceptionRows.entries()].map(([rowNumber, codes]) => ({
      row: sourceRows.find((r) => r.rowNumber === rowNumber),
      status: exceptionStatus,
      fields: [],
      errors: codes,
    })),
  ].sort((a, b) => a.row.rowNumber - b.row.rowNumber);

  const invalidColumns = [...table.headers, ...ADDITIONAL_INVALID_COLUMNS];
  const invalidRows = invalidTrips.map((x) => {
    const out = {};
    table.headers.forEach((h, i) => { out[h] = x.row.original[i]; });
    out['Source Row Number'] = String(x.row.rowNumber);
    out['Validation Status'] = x.status;
    out['Invalid Fields'] = x.fields.join('; ');
    out['Validation Errors'] = x.errors.join('; ');
    return out;
  });

  const exceptionsByCode = {};
  for (const e of exceptions) exceptionsByCode[e.code] = (exceptionsByCode[e.code] || 0) + (e.count || e.rows.length);

  const summary = {
    rowsRead: sourceRows.length,
    validRows: valid.length,
    invalidRows: invalid.length,
    duplicatesRemoved: duplicateRows.length,
    exceptionRows: exceptionRows.size,
    journeys: journeys.filter((j) => j.journeyId).length,
    journeysReused: reusedCount,
    outputRows: destinationRows.length,
    originalTripDates: originalDates,
    effectiveTripDate: overrideDate ? D.ymdKey(overrideDate) : (originalDates.length === 1 ? originalDates[0] : null),
    dateChanged: Boolean(overrideDate),
    unknownSpaceTypes: [...unknownSpaceTypes],
    exceptionsByCode,
  };

  return {
    destinationColumns: rules.destination_columns,
    destinationRows,
    invalidColumns,
    invalidRows,
    exceptions,
    summary,
  };
}

function mapRow(n, journeyId, legId, rules, unknownSpaceTypes) {
  const fr = rules.field_rules;
  const v = n.values;
  const name = F.splitClientName(v['Client Name'], v['Passenger Ty'], fr.client_name);
  const phones = F.extractPhones(v.Comments, fr.phones.maximum);
  const space = F.spaceType(v['Space Type'], fr.space_type);
  if (!space.known) unknownSpaceTypes.add(F.collapse(v['Space Type']));
  const out = {
    'Journey ID': journeyId,
    'Leg ID': legId,
    'Last Name': name.last,
    'First Name': name.first,
    'Middle Name': fr.client_name.targets['Middle Name'],
    'Tobi MRN': F.tobiMrn(v['Client ID'], v['Passenger Ty'], fr.tobi_mrn),
    'Trip Date': D.formatDestination(n.date),
    'Pickup Time': D.formatDestination(n.date, n.puTime),
    'Dropoff Time': n.doTime ? D.formatDestination(n.date, n.doTime) : '',
    Mode: fr.mode.default,
    'Service Area': fr.service_area.default,
    'Pickup Address': n.pickup.street,
    'Pickup Suite': n.pickup.suite,
    'Pickup City': F.collapse(v.PUCity),
    'Pickup State': fr.pickup_address.constant['Pickup State'],
    'Pickup Zip': F.collapse(v.PUZipcode),
    'Dropoff Address': n.dropoff.street,
    'Dropoff Suite': n.dropoff.suite,
    'Dropoff City': F.collapse(v.DOCity),
    'Dropoff State': fr.dropoff_address.constant['Dropoff State'],
    'Dropoff Zip': F.collapse(v.DOZipcode),
    'Booking Fare': String(F.bookingFare(v.Amount)),
    'Pickup Gate Code': F.gateCode(v.Comments),
    'Primary Phone': phones[0] || fr.phones['Primary Phone'].default,
    'Secondary Phone': phones[1] || fr.phones['Secondary Phone'].default,
    'Tobi Tags': F.tobiTags(v.Comments, fr.tobi_tags),
    'Trip Purpose': F.tripPurpose(v.PickUpLocationName, v.DropLocationName, fr.trip_purpose),
    'Leg Notes': F.legNotes(v, fr.leg_notes),
    'Booking Notes': F.bookingNotes(v.Comments, v['Space Type'], fr.booking_notes),
    'Seating Need': space.value,
    'Service Type': space.value,
  };
  return out;
}

module.exports = { processViajes, distinctTripDates, applyTripDateOverride, ProcessingError, validateRow };
