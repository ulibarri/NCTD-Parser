'use strict';

// Field-level rules (field_rules in the JSON): names, MRN, addresses,
// fare, phones, gate code, tags, notes, trip purpose and space type.

const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const upper = (s) => collapse(s).toUpperCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isMissing(value, markers) {
  const v = String(value ?? '').trim().toUpperCase();
  return markers.some((m) => m.toUpperCase() === v);
}

/** Client Name -> Last Name / First Name, with the " - PCA" suffix for assistants. */
function splitClientName(clientName, passengerType, rule) {
  let name = collapse(clientName);
  const suffixRule = rule.assistant_name_suffix;
  if (suffixRule && suffixRule.when_passenger_type_in.includes(upper(passengerType))) {
    if (!name.toUpperCase().endsWith(suffixRule.suffix.toUpperCase())) name += suffixRule.suffix;
  }
  const i = name.indexOf(rule.split_at_first);
  if (i === -1) return { last: name, first: '', middle: '' };
  return { last: name.slice(0, i).trim(), first: name.slice(i + 1).trim(), middle: '' };
}

/** Client ID -> Tobi MRN (adds _PCA only for Passenger Ty = PCA). */
function tobiMrn(clientId, passengerType, rule) {
  const id = collapse(clientId);
  const when = rule.pca_rule.when['Passenger Ty'];
  const suffix = rule.pca_rule.append_suffix;
  if (upper(passengerType) === when.toUpperCase() && !id.toUpperCase().endsWith(suffix.toUpperCase())) return id + suffix;
  return id;
}

const STREET_SUFFIXES = ['ST', 'STREET', 'AVE', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE', 'BLVD', 'LN', 'LANE', 'CT', 'COURT',
  'WAY', 'PL', 'PLACE', 'CIR', 'CIRCLE', 'TER', 'TERRACE', 'PKWY', 'TRL', 'TRAIL', 'LOOP', 'ROW', 'SQ'];

/**
 * Splits an address into street and secondary (suite) parts.
 * Recognizes indicators with or without a space before the unit number
 * (UNIT 4, UNIT100, SPC131, # 159) and a standalone trailing unit number
 * after a street suffix (e.g. "123 MAIN ST 5").
 */
function splitAddress(address, indicators) {
  const text = collapse(address);
  if (!text) return { street: '', suite: '' };
  const words = indicators
    .filter((x) => x !== '#' && x !== 'standalone trailing unit')
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
  // A unit with a digit may be glued to the indicator (UNIT100, SPC131);
  // a single-letter unit needs a space (APT B) so words like "SPA" are not split.
  const unit = '\\s*#?\\s*[A-Z]?\\d[A-Z0-9-]*|\\s+#?\\s*[A-Z]';
  const withWord = new RegExp(`^(.*\\S)\\s+((?:${words})\\.?(?:${unit}))$`, 'i');
  const withHash = new RegExp(`^(.*\\S)\\s+(#\\s*(?:[A-Z]?\\d[A-Z0-9-]*|[A-Z]))$`, 'i');
  let m = text.match(withWord) || text.match(withHash);
  if (m) return { street: m[1].trim(), suite: m[2].trim() };
  if (indicators.includes('standalone trailing unit')) {
    m = text.match(/^(.*\s(\S+))\s+([A-Z]?\d+[A-Z]?)$/i);
    if (m && STREET_SUFFIXES.includes(m[2].replace('.', '').toUpperCase())) return { street: m[1].trim(), suite: m[3] };
  }
  return { street: text, suite: '' };
}

/** Amount -> Booking Fare (number > 0, otherwise 0). */
function bookingFare(amount) {
  const cleaned = String(amount ?? '').replace(/[$,\s]/g, '').replace(/^USD/i, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return 0;
  const n = Number(cleaned);
  return n > 0 ? Math.round(n * 100) / 100 : 0;
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

/** Up to two valid 10-digit US phone numbers found in Comments. */
function extractPhones(comments, max = 2) {
  const found = [];
  for (const m of String(comments ?? '').matchAll(PHONE_RE)) {
    let digits = m[0].replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    if (digits.length === 10 && !found.includes(digits)) found.push(digits);
    if (found.length === max) break;
  }
  return found;
}

/** Code that follows "GATE CODE" in Comments (separators : # - are dropped). */
function gateCode(comments) {
  const m = String(comments ?? '').match(/GATE\s*CODE\s*(?:IS\s*)?[:#-]?\s*#?\s*([A-Z0-9*]+)/i);
  return m ? m[1] : '';
}

function joinUnique(values, delimiter) {
  const out = [];
  for (const v of values) {
    const t = collapse(v);
    if (t && !out.some((o) => o.toUpperCase() === t.toUpperCase())) out.push(t);
  }
  return out.join(delimiter);
}

function tobiTags(comments, rule) {
  const text = upper(comments);
  const tags = rule.rules
    .filter((r) => r.phrases.some((p) => new RegExp(`(^|[^A-Z])${escapeRe(p.toUpperCase())}([^A-Z]|$)`).test(text)))
    .map((r) => r.value);
  return joinUnique(tags, rule.delimiter);
}

function bookingNotes(comments, spaceType, rule) {
  const parts = [comments];
  for (const r of rule.append_rules) {
    if (upper(spaceType) === String(r.when['Space Type']).toUpperCase()) parts.push(r.value);
  }
  return joinUnique(parts, rule.delimiter);
}

/** Keywords are matched inside the location names; pickup is checked first. */
function tripPurpose(pickupName, dropName, rule) {
  for (const name of [pickupName, dropName]) {
    const text = upper(name);
    if (!text) continue;
    for (const [keyword, purpose] of Object.entries(rule.mapping)) {
      if (text.includes(keyword.toUpperCase())) return purpose;
    }
  }
  return rule.default;
}

function legNotes(values, rule) {
  return rule.parts
    .map((p) => ({ p, v: collapse(values[p.source]) }))
    .filter(({ v }) => !rule.omit_blank || v)
    .map(({ p, v }) => p.prefix + v)
    .join(rule.delimiter);
}

/** Space Type -> Seating Need / Service Type. Returns { value, known }. */
function spaceType(value, rule) {
  const code = upper(value);
  if (Object.prototype.hasOwnProperty.call(rule.mapping, code)) return { value: rule.mapping[code], known: true };
  return { value: rule.default, known: code === '' };
}

module.exports = {
  collapse,
  upper,
  isMissing,
  splitClientName,
  tobiMrn,
  splitAddress,
  bookingFare,
  extractPhones,
  gateCode,
  tobiTags,
  bookingNotes,
  tripPurpose,
  legNotes,
  spaceType,
  joinUnique,
};
