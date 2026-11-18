'use strict';

// Processing pipeline for the Viajes file, following processing_pipeline in
// config/rules/nctd_manifest_parser_rules_v2.5.0.json.
//
// v2.0.0: Vendor ID and Leg ID are deterministic and alphanumeric
// ({AlnumClientID}{YYYYMMDD}{HHMM}[PCA][A|B]); clients and companions are
// paired separately; collisions and ambiguous pairing block the export.

const D = require('./dates');
const F = require('./fields');
const { applyCatalog } = require('./pasajeros');

const ADDITIONAL_INVALID_COLUMNS = ['Source Row Number', 'Validation Status', 'Invalid Fields', 'Validation Errors'];

class ProcessingError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

/** Hidden marker on Output rows (not exported): true for PCA/COM/COMP rows. */
const COMPANION = Symbol('companion');

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
  const idFields = new Set(v.missing_id_component.fields);
  const invalidFields = [];
  const errors = [];
  const flag = (field, problem) => {
    invalidFields.push(field);
    errors.push(`${field}: ${problem}${idFields.has(field) ? ` (${v.missing_id_component.code})` : ''}`);
  };
  for (const field of v.fields) {
    const value = values[field];
    if (F.isMissing(value, markers)) {
      flag(field, 'missing value');
      continue;
    }
    const format = v.format_rules[field];
    let ok = true;
    if (field === 'TripDate') ok = Boolean(D.parseTripDate(value));
    else if (field === 'PUTime') ok = Boolean(D.parseTime(value));
    else if (field === 'Client ID') ok = F.alnum(value) !== '';
    else if (typeof format === 'string') ok = new RegExp(format).test(F.collapse(value));
    if (!ok) flag(field, field === 'Client ID' ? 'no letters or digits' : 'invalid format');
  }
  // CLIENT-NAME-FORMAT-001: LAST,FIRST with text on both sides (v2.4.0)
  const nameRule = rules.field_rules.client_name;
  const nameCheck = nameRule.invalid_format;
  if (nameCheck && !invalidFields.includes('Client Name')) {
    const raw = F.collapse(values['Client Name']);
    const identity = F.passengerIdentity(values['Passenger Ty'], rules);
    const { last, baseFirst } = F.splitClientName(raw, values['Passenger Ty'], nameRule, identity ? identity.suffix : '');
    if (!raw.includes(nameRule.split_at_first) || !last || !baseFirst) {
      invalidFields.push('Client Name');
      errors.push(`Client Name: invalid format, expected LAST,FIRST (${nameCheck.code})`);
    }
  }
  return { invalidFields, errors };
}

const locationId = (loc) => [loc.street, loc.suite, loc.city, loc.zip].map(F.upper).join('|');
const hhmm = (t) => `${D.pad(t.h)}${D.pad(t.mi)}`;
const yyyymmdd = (d) => `${d.y}${D.pad(d.m)}${D.pad(d.d)}`;

/**
 * Pairs reciprocal legs inside one group (same client, date and companion status).
 * A return is a candidate for an outbound row when it starts later and no other
 * row with the outbound route starts in between (and the same in reverse), so
 * two round trips on the same day stay unambiguous. More than one candidate on
 * either side is AMBIGUOUS_PAIRING.
 * @returns {{ pairs: [object, object][], ambiguous: Set<object> }}
 */
function pairGroup(legs) {
  const t = (l) => D.timeKey(l.puTime);
  const route = (l) => `${locationId(l.pickup)}>${locationId(l.dropoff)}`;
  const reverse = (l) => `${locationId(l.dropoff)}>${locationId(l.pickup)}`;
  const between = (r, from, to) => legs.some((c) => route(c) === r && t(c) > from && t(c) < to);

  const forward = new Map(); // outbound -> candidate returns
  const backward = new Map(); // return -> candidate outbounds
  for (const a of legs) {
    forward.set(a, legs.filter((b) => b !== a && route(b) === reverse(a) && t(b) > t(a) && !between(route(a), t(a), t(b))));
    backward.set(a, legs.filter((b) => b !== a && route(b) === reverse(a) && t(b) < t(a) && !between(route(a), t(b), t(a))));
  }
  const ambiguous = new Set();
  for (const a of legs) {
    for (const list of [forward.get(a), backward.get(a)]) {
      if (list.length > 1) {
        ambiguous.add(a);
        list.forEach((b) => ambiguous.add(b));
      }
    }
  }
  const pairs = [];
  const used = new Set();
  for (const a of [...legs].sort((x, y) => t(x).localeCompare(t(y)))) {
    const f = forward.get(a);
    if (used.has(a) || ambiguous.has(a) || f.length !== 1) continue;
    const b = f[0];
    if (used.has(b) || ambiguous.has(b) || backward.get(b).length !== 1 || backward.get(b)[0] !== a) continue;
    pairs.push([a, b]);
    used.add(a);
    used.add(b);
  }
  return { pairs, ambiguous };
}

/**
 * Processes a Viajes table.
 * @param {object} p
 * @param {{ columns: string[], headers: string[], rows: object[] }} p.table
 * @param {object} p.rules
 * @param {{y:number,m:number,d:number}|null} [p.overrideDate]
 * @param {{ headers: string[], columns: string[], rows: object[] }|null} [p.catalog] uploaded Pasajeros (passenger catalog)
 */
async function processViajes({ table, rules, overrideDate = null, catalog = null, legIdV2Mode = false, legIdV2Sequence = null }) {
  const fr = rules.field_rules;
  // Exceptions marked "blocking_when_experimental_mode_enabled" (v2.6.0) block only
  // in TOBI_INDEPENDENT_LEGS_V2 mode; otherwise they are reported as warnings.
  const severity = Object.fromEntries(Object.entries(rules.exceptions).map(([code, level]) => [code,
    level === 'blocking_when_experimental_mode_enabled' ? (legIdV2Mode ? 'blocking' : 'warning') : level]));
  const exceptions = []; // { code, severity, rows: number[], count? }
  const addException = (code, rowNumbers, extra = {}) => {
    exceptions.push({ code, severity: severity[code] || 'error', rows: [...new Set(rowNumbers)].sort((a, b) => a - b), ...extra });
  };

  // read_source + preserve_original_rows
  const sourceRows = table.rows;
  const originalDates = distinctTripDates(sourceRows);

  // apply_trip_date_override
  if (overrideDate && originalDates.length > 1) {
    throw new ProcessingError('MULTIPLE_TRIP_DATES', { dates: originalDates });
  }

  // validate_required_fields + route_invalid_rows
  const invalid = [];
  const valid = [];
  // clean_source_characters (SOURCE-SPECIAL-CHARS-001); row.original is kept for Invalid Trips
  const cleanup = rules.normalization.source_character_cleanup;
  // remove_client_name_nicknames (CLIENT-NAME-NICKNAME-001, v2.8.1): the nickname goes to Booking Notes
  const nicknameRule = rules.field_rules.client_name.nickname_removal;
  const cleaned = sourceRows.map((row) => {
    const values = { ...row.values };
    let nicknames = [];
    if (nicknameRule && 'Client Name' in values) {
      const r = F.removeNicknames(values['Client Name'], nicknameRule);
      values['Client Name'] = r.value;
      nicknames = r.nicknames;
    }
    if (cleanup) for (const c of cleanup.columns) if (c in values) values[c] = F.removeCharacters(values[c], cleanup.remove_characters);
    return { ...row, values, nicknames };
  });
  for (const row of cleaned) {
    const { invalidFields, errors } = validateRow(row.values, rules);
    if (invalidFields.length) invalid.push({ row, status: rules.required_field_validation.invalid_action.status, fields: invalidFields, errors });
    else valid.push(row);
  }
  const missingIdRows = invalid.filter((x) => x.errors.some((e) => e.includes(rules.required_field_validation.missing_id_component.code)));
  if (missingIdRows.length) addException('MISSING_ID_COMPONENT', missingIdRows.map((x) => x.row.rowNumber));
  const nameCode = fr.client_name.invalid_format && fr.client_name.invalid_format.code;
  const badNameRows = nameCode ? invalid.filter((x) => x.errors.some((e) => e.includes(nameCode))) : [];
  if (badNameRows.length) addException(nameCode, badNameRows.map((x) => x.row.rowNumber));

  // normalize_valid_rows
  const collapseFields = new Set(rules.normalization.collapse_whitespace_fields);
  const normalized = valid.map((row) => {
    const values = {};
    for (const [k, v] of Object.entries(row.values)) {
      values[k] = collapseFields.has(k) ? F.collapse(v) : String(v ?? '').trim();
    }
    const pu = F.splitAddress(values.PUAddress, fr.pickup_address.secondary_indicators);
    const dropoff = F.splitAddress(values.DOAddress, fr.dropoff_address.secondary_indicators);
    return {
      row,
      values,
      passengerType: F.upper(values['Passenger Ty']),
      date: overrideDate || D.parseTripDate(values.TripDate),
      puTime: D.parseTime(values.PUTime),
      doTime: D.parseTime(values.DOAppt),
      pickup: { street: pu.street, suite: pu.suite, city: values.PUCity, zip: values.PUZipcode },
      dropoff: { street: dropoff.street, suite: dropoff.suite, city: values.DOCity, zip: values.DOZipcode },
    };
  });

  // remove_exact_duplicates (every normalized Source column identical)
  const seen = new Set();
  const unique = [];
  const duplicateRows = [];
  for (const n of normalized) {
    const key = JSON.stringify(table.columns.map((c) => (c === 'TripDate' ? D.ymdKey(n.date) : n.values[c])));
    if (seen.has(key)) duplicateRows.push(n.row.rowNumber);
    else {
      seen.add(key);
      unique.push(n);
    }
  }
  if (duplicateRows.length) addException(rules.exact_duplicate_rule.code, duplicateRows);

  // classify_passengers (unknown types go to Invalid Trips)
  const errorRows = new Map(); // rowNumber -> codes (rows routed to Invalid Trips)
  const legs = [];
  const unknownType = [];
  for (const n of unique) {
    const identity = rules.passenger_types[n.passengerType] ? F.passengerIdentity(n.passengerType, rules) : null;
    if (!identity) {
      unknownType.push(n);
      errorRows.set(n.row.rowNumber, ['UNKNOWN_PASSENGER_TYPE']);
      continue;
    }
    // build_id_components (PASSENGER-IDENTITY-002: PCA -> PCA, COM/COMP -> COM)
    const companion = identity.role === 'companion';
    legs.push({
      ...n, companion, suffix: identity.suffix, pairClass: identity.pairClass,
      baseId: F.alnumClientId(n.values['Client ID'], companion, identity.suffix),
    });
  }
  if (unknownType.length) addException('UNKNOWN_PASSENGER_TYPE', unknownType.map((n) => n.row.rowNumber));

  // pair_reciprocal_legs (group by AlnumClientID, effective date and pairing class:
  // CLI, PCA or COM; PCA never pairs with COM/COMP, PAIRING-001-OVERRIDE-002)
  const groups = new Map();
  for (const l of legs) {
    const k = [l.baseId.toUpperCase(), D.ymdKey(l.date), l.pairClass].join('␟');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const ambiguousRows = [];
  let nonReciprocal = 0;
  let pairsCount = 0;
  for (const g of groups.values()) {
    const { pairs, ambiguous } = pairGroup(g);
    pairsCount += pairs.length;
    for (const [a, b] of pairs) {
      a.letter = 'A'; a.pairStatus = rules.pairing.paired['Pair Status'];
      b.letter = 'B'; b.pairStatus = rules.pairing.paired['Pair Status'];
    }
    for (const l of g) {
      if (ambiguous.has(l)) {
        l.letter = '';
        l.pairStatus = 'Ambiguous';
        ambiguousRows.push(l.row.rowNumber);
      } else if (!l.letter) {
        l.letter = rules.pairing.unpaired['Leg letter'];
        l.pairStatus = rules.pairing.unpaired['Pair Status'];
        if (g.length > 1) nonReciprocal += 1;
      }
    }
  }
  if (ambiguousRows.length) addException('AMBIGUOUS_PAIRING', ambiguousRows);
  if (nonReciprocal) exceptions.push({ code: 'NONRECIPROCAL_ROUTE', severity: severity.NONRECIPROCAL_ROUTE, rows: [], count: nonReciprocal });

  // generate_vendor_id + generate_leg_id + map_destination_fields
  legs.sort((x, y) => D.ymdKey(x.date).localeCompare(D.ymdKey(y.date))
    || x.baseId.localeCompare(y.baseId, 'en', { numeric: true })
    || D.timeKey(x.puTime).localeCompare(D.timeKey(y.puTime))
    || Number(x.companion) - Number(y.companion)
    || x.pairClass.localeCompare(y.pairClass)
    || x.row.rowNumber - y.row.rowNumber);
  const unknownSpaceTypes = new Set();
  const v2Rule = rules.experimental_rules && rules.experimental_rules.leg_id_v2;
  const destinationRows = legs.map((l) => {
    const base = `${l.baseId}${yyyymmdd(l.date)}${hhmm(l.puTime)}${l.companion ? l.suffix : ''}`;
    const out = mapRow(l, base, l.letter ? base + l.letter : '', rules, unknownSpaceTypes);
    if (v2Rule) out['Leg ID V2'] = legIdV2(out, l.values['Passenger Ty'], v2Rule);
    Object.defineProperty(out, COMPANION, { value: l.companion });
    out.__row = l.row.rowNumber; // removed below; used for collision reporting
    return out;
  });
  if (unknownSpaceTypes.size) exceptions.push({ code: 'UNKNOWN_SPACE_TYPE', severity: severity.UNKNOWN_SPACE_TYPE, rows: [], count: unknownSpaceTypes.size, values: [...unknownSpaceTypes] });

  // validate_destination + detect_collisions
  const vendorRe = new RegExp(rules.validation_patterns['Vendor ID']);
  const legRe = new RegExp(rules.validation_patterns['Leg ID']);
  const badVendor = destinationRows.filter((d) => !vendorRe.test(d['Vendor ID'])).map((d) => d.__row);
  const badLeg = destinationRows.filter((d) => d['Leg ID'] && !legRe.test(d['Leg ID'])).map((d) => d.__row);
  if (badVendor.length) addException('INVALID_VENDOR_ID', badVendor);
  if (badLeg.length) addException('INVALID_LEG_ID', badLeg);
  const collisions = (column, code) => {
    const byId = new Map();
    for (const d of destinationRows) {
      if (!d[column]) continue;
      if (!byId.has(d[column])) byId.set(d[column], []);
      byId.get(d[column]).push(d.__row);
    }
    const dup = [...byId.entries()].filter(([, rows]) => rows.length > 1);
    if (dup.length) addException(code, dup.flatMap(([, rows]) => rows), { ids: dup.map(([id]) => id) });
  };
  collisions('Vendor ID', rules.identifiers.vendor_id.collision_code);
  collisions('Leg ID', rules.identifiers.leg_id.collision_code);
  // generate_leg_id_v2 validation (LEG-ID-V2-EXPERIMENTAL-001, VAL-011 / VAL-012)
  // LEG-ID-V2-SEQUENTIAL-001 (v2.8.0): optional L000001, L000002, ... in Output row order
  const seqRule = v2Rule && v2Rule.sequential_option;
  let sequence = null;
  if (seqRule && legIdV2Sequence) {
    const { prefix, digits } = seqRule.format;
    const start = legIdV2Sequence.start;
    const last = start + destinationRows.length - 1;
    if (destinationRows.length && last > seqRule.start.maximum) {
      addException(seqRule.overflow.code, destinationRows.map((d) => d.__row));
    } else {
      destinationRows.forEach((d, i) => { d['Leg ID V2'] = `${prefix}${String(start + i).padStart(digits, '0')}`; });
    }
    sequence = {
      start,
      first: destinationRows.length ? destinationRows[0]['Leg ID V2'] : null,
      last: destinationRows.length ? destinationRows[destinationRows.length - 1]['Leg ID V2'] : null,
      nextStart: last + 1,
    };
  }
  if (v2Rule) {
    const v2Re = new RegExp(v2Rule.allowed_regex);
    const badV2 = destinationRows.filter((d) => !v2Re.test(d['Leg ID V2'] || '')).map((d) => d.__row);
    if (badV2.length) addException(v2Rule.invalid_code, badV2);
    collisions('Leg ID V2', v2Rule.collision_code);
  }
  // passenger_catalog (CATALOG-001): locked First Name, Last Name and Primary Phone
  const catalogResult = applyCatalog(catalog, destinationRows, (d) => d.__row, rules);
  exceptions.push(...catalogResult.exceptions);

  for (const d of destinationRows) delete d.__row;

  const blocking = exceptions.filter((e) => e.severity === 'blocking');

  // Invalid Trips: invalid rows + rows with error-level exceptions
  const invalidTrips = [
    ...invalid.map((x) => ({ row: x.row, status: x.status, fields: x.fields, errors: x.errors })),
    ...[...errorRows.entries()].map(([rowNumber, codes]) => ({
      row: sourceRows.find((r) => r.rowNumber === rowNumber), status: 'EXCEPTION', fields: [], errors: codes,
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
    invalidRows: invalidRows.length,
    duplicatesRemoved: duplicateRows.length,
    outputRows: destinationRows.length,
    pairs: pairsCount,
    unpairedLegs: legs.filter((l) => l.pairStatus === rules.pairing.unpaired['Pair Status']).length,
    exportReady: blocking.length === 0,
    blockingErrors: new Set(blocking.flatMap((e) => e.rows)).size,
    originalTripDates: originalDates,
    effectiveTripDate: overrideDate ? D.ymdKey(overrideDate) : (originalDates.length === 1 ? originalDates[0] : null),
    dateChanged: Boolean(overrideDate),
    unknownSpaceTypes: [...unknownSpaceTypes],
    catalogProvided: catalogResult.provided,
    catalogMatched: catalogResult.matched,
    pasajerosAdded: catalogResult.added,
    catalogMigrated: catalogResult.migrated,
    catalogPhonesMigrated: catalogResult.phonesMigrated,
    legIdV2Mode: Boolean(legIdV2Mode),
    legIdV2Sequence: sequence,
    legIdV2ModeName: v2Rule ? v2Rule.export_adapter.independent_legs_experimental_mode.mode_name : null,
    exceptionsByCode,
  };

  return {
    destinationColumns: rules.destination_columns,
    destinationRows,
    invalidColumns,
    invalidRows,
    exceptions,
    summary,
    catalog: { headers: catalogResult.headers, rows: catalogResult.rows },
  };
}

/**
 * Leg ID V2 (LEG-ID-V2-EXPERIMENTAL-001): CLI copies Leg ID, PCA/COM/COMP copy
 * Vendor ID. Vendor ID, Leg ID and the other columns are not changed.
 */
function legIdV2(row, passengerType, rule) {
  const type = F.upper(passengerType);
  const match = rule.rules.find((r) => r.when['Passenger Ty'].includes(type));
  return match ? row[match.value_from] || '' : '';
}

/**
 * Date-only and time-only columns (rules v2.10.0, DATE-TIME-SPLIT-001). Each
 * column says its source (PUTime, DOAppt or the effective trip date) and its
 * format; Dropoff columns stay empty when DOAppt is empty, like Dropoff Time.
 */
function splitDateTime(l, split, columns) {
  if (!split) return {};
  const out = {};
  for (const [column, spec] of Object.entries(split)) {
    if (!spec || typeof spec !== 'object' || !spec.format || !columns.includes(column)) continue;
    const needsDropoff = spec.empty_when_DOAppt_empty && !l.doTime;
    if (needsDropoff) { out[column] = ''; continue; }
    const time = spec.source === 'PUTime' ? l.puTime : spec.source === 'DOAppt' ? l.doTime : null;
    out[column] = spec.kind === 'time' ? (time ? D.formatWith(spec.format, null, time) : '') : D.formatWith(spec.format, l.date);
  }
  return out;
}

function mapRow(l, vendorId, legId, rules, unknownSpaceTypes) {
  const fr = rules.field_rules;
  const v = l.values;
  const name = F.splitClientName(v['Client Name'], v['Passenger Ty'], fr.client_name, l.suffix);
  const phones = F.extractPhones(v.Comments, fr.phones.maximum);
  const space = F.spaceType(v['Space Type'], fr.space_type);
  if (!space.known) unknownSpaceTypes.add(F.collapse(v['Space Type']));
  return {
    'Vendor ID': vendorId,
    'Leg ID': legId,
    // position kept from destination_columns; filled after mapping (v2.6.0)
    ...(rules.destination_columns.includes('Leg ID V2') ? { 'Leg ID V2': '' } : {}),
    'Pair Status': l.pairStatus,
    'Last Name': name.last,
    'First Name': name.first,
    'Middle Name': name.middle,
    'Tobi MRN': F.tobiMrn(l.baseId, l.companion, l.suffix),
    'Trip Date': D.formatDestination(l.date),
    'Pickup Time': D.formatDestination(l.date, l.puTime),
    'Dropoff Time': l.doTime ? D.formatDestination(l.date, l.doTime) : '',
    // v2.10.0 DATE-TIME-SPLIT-001: date and time in separate columns
    ...splitDateTime(l, fr.dates_and_times.split_columns, rules.destination_columns),
    Mode: fr.mode.default,
    'Service Area': fr.service_area.default,
    'Pickup Address': l.pickup.street,
    'Pickup Suite': l.pickup.suite,
    'Pickup City': F.collapse(v.PUCity),
    'Pickup State': fr.pickup_address.constant['Pickup State'],
    'Pickup Zip': F.collapse(v.PUZipcode),
    'Dropoff Address': l.dropoff.street,
    'Dropoff Suite': l.dropoff.suite,
    'Dropoff City': F.collapse(v.DOCity),
    'Dropoff State': fr.dropoff_address.constant['Dropoff State'],
    'Dropoff Zip': F.collapse(v.DOZipcode),
    'Booking Fare': String(F.bookingFare(v.Amount)),
    'Pickup Gate Code': F.gateCode(v.Comments),
    'Primary Phone': phones[0] || fr.phones['Primary Phone'].default,
    'Secondary Phone': phones[1] || fr.phones['Secondary Phone'].default,
    'Tobi Tags': F.tobiTags(v, fr.tobi_tags),
    'Trip Purpose': F.tripPurpose(v.PickUpLocationName, v.DropLocationName, fr.trip_purpose),
    'Leg Notes': F.legNotes(v, fr.leg_notes),
    'Booking Notes': F.bookingNotes(v.Comments, v['Space Type'], fr.booking_notes,
      [F.nicknameNote(l.row.nicknames, fr.client_name.nickname_removal)].filter(Boolean)),
    'Seating Need': space.value,
    'Service Type': space.value,
  };
}

/** Validates the start number of LEG-ID-V2-SEQUENTIAL-001; returns it or null. */
function parseSequenceStart(value, rules) {
  const rule = rules.experimental_rules && rules.experimental_rules.leg_id_v2 && rules.experimental_rules.leg_id_v2.sequential_option;
  if (!rule) return null;
  const text = String(value ?? rule.start.default).trim();
  if (!/^[0-9]+$/.test(text)) return null;
  const n = Number(text);
  return n >= rule.start.minimum && n <= rule.start.maximum ? n : null;
}

module.exports = {
  parseSequenceStart, processViajes, distinctTripDates, applyTripDateOverride, ProcessingError, validateRow, pairGroup, COMPANION };
