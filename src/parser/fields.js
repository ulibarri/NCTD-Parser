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

/** Removes every character outside A-Z, a-z and 0-9 (normalization.id_component_cleanup). */
const alnum = (s) => String(s ?? '').replace(/[^A-Za-z0-9]/g, '');

const appendOnce = (value, suffix) => (value.toUpperCase().endsWith(suffix.toUpperCase()) ? value : value + suffix);

/**
 * SOURCE-SPECIAL-CHARS-001: removes the listed characters (for example ( ) [ ])
 * and collapses spaces; the enclosed text is kept.
 */
function removeCharacters(value, chars) {
  let out = String(value ?? '');
  for (const ch of chars) out = out.split(ch).join(' ');
  return collapse(out);
}

/**
 * Passenger identity (PASSENGER-IDENTITY-002, v2.7.0): trip role, technical
 * suffix (CLI "", PCA "PCA", COM/COMP "COM") and pairing class
 * (PAIRING-001-OVERRIDE-002). Falls back to the pre-v2.7.0 rules.
 * Returns null for an unknown Passenger Ty.
 */
function passengerIdentity(passengerType, rules) {
  const type = upper(passengerType);
  const v27 = rules.passenger_identity_v2_7;
  if (v27) {
    const c = v27.classification[type];
    if (!c) return null;
    const classes = rules.pairing_override_v2_7 && rules.pairing_override_v2_7.canonical_pairing_classes;
    return { role: c.trip_role, suffix: c.canonical_identity_suffix, pairClass: (classes && classes[type]) || type };
  }
  const t = rules.passenger_types[type];
  if (!t) return null;
  const companion = t.classification === 'companion';
  return {
    role: t.classification,
    suffix: companion ? rules.companion_definition.canonical_suffix : '',
    pairClass: companion ? 'COMPANION' : 'CLIENT',
  };
}

/**
 * Client Name -> Last Name / First Name (split at the first comma).
 * Companions (PCA, COM, COMP), NAME-003 (v2.7.0/v2.7.1): legacy suffixes are
 * removed once (COMPANION-LASTNAME-CLEANUP-001, COMPANION-FIRSTNAME-CLEANUP-002),
 * then First Name gets "-PCA" or "-COM" exactly once; Last Name gets no suffix.
 * baseFirst / baseLast are the names before the visible suffix (used by
 * CLIENT-NAME-FORMAT-001).
 */
function splitClientName(clientName, passengerType, rule, identitySuffix = '') {
  const name = collapse(clientName);
  const i = name.indexOf(rule.split_at_first);
  let last = i === -1 ? name : name.slice(0, i).trim();
  let first = i === -1 ? '' : name.slice(i + 1).trim();
  let baseFirst = first;
  const c = rule.companion_suffixes;
  if (c && c.when_passenger_type_in.includes(upper(passengerType))) {
    last = cleanWith(last, rule.legacy_last_name_cleanup);
    if (last && c['Last Name']) last = appendOnce(last, c['Last Name']);
    baseFirst = cleanWith(first, rule.legacy_first_name_cleanup);
    const template = c['First Name'] || '';
    first = baseFirst && template.includes('{identity_suffix}') && identitySuffix
      ? appendOnce(baseFirst, template.replace('{identity_suffix}', identitySuffix))
      : baseFirst;
  }
  return { last, first, baseFirst, middle: rule.targets['Middle Name'] };
}

/** Removes one trailing match of a cleanup rule's regex (case-insensitive). */
function cleanWith(value, cleanup) {
  if (!cleanup || !value) return value;
  return value.replace(new RegExp(cleanup.regex, 'i'), cleanup.replacement || '').trim();
}

/** Kept for callers of v2.3.0-v2.6.0: removes a legacy trailing companion suffix from First Name. */
function cleanLegacyFirstName(first, rule) {
  return cleanWith(first, rule.legacy_first_name_cleanup);
}

/**
 * Alphanumeric Client ID used in Tobi MRN, Vendor ID and Leg ID.
 * For companions a trailing suffix of the same identity (PCA, or COM for
 * COM/COMP; also legacy _PCA / -PCA) is removed first, so it is never duplicated.
 */
function alnumClientId(clientId, isCompanion, suffix = 'PCA') {
  let id = alnum(clientId);
  if (isCompanion && id.toUpperCase().endsWith(suffix) && id.length > suffix.length) id = id.slice(0, -suffix.length);
  return id;
}

/** Tobi MRN: {AlnumClientID} for clients, {AlnumClientID}PCA or {AlnumClientID}COM for companions. */
/**
 * Tobi MRN. Since v2.11.0 (MRN-PREFIX-001) it starts with a prefix (NCTD):
 * NCTD1365, NCTD1365PCA, NCTD1365COM. A Client ID that already starts with
 * the prefix does not get it twice.
 */
function tobiMrn(baseId, isCompanion, suffix = 'PCA', prefix = '') {
  const id = isCompanion ? baseId + suffix : baseId;
  return withPrefix(id, prefix);
}

/** Adds the prefix once (letters and digits compared, case-insensitive). */
function withPrefix(value, prefix = '') {
  const v = String(value ?? '');
  if (!prefix || !v) return v;
  return alnum(v).toUpperCase().startsWith(alnum(prefix).toUpperCase()) ? v : prefix + v;
}

const STREET_SUFFIXES = ['ST', 'STREET', 'AVE', 'AVENUE', 'RD', 'ROAD', 'DR', 'DRIVE', 'BLVD', 'LN', 'LANE', 'CT', 'COURT',
  'WAY', 'PL', 'PLACE', 'CIR', 'CIRCLE', 'TER', 'TERRACE', 'PKWY', 'TRL', 'TRAIL', 'LOOP', 'ROW', 'SQ'];

/**
 * Splits an address into street and secondary (suite) parts.
 * Recognizes indicators with or without a space before the unit number
 * (UNIT 4, UNIT100, SPC131, # 159) and a standalone trailing unit number
 * after a street suffix (e.g. "123 MAIN ST 5").
 *
 * v2.12.0 ADDRESS-SUITE-002 (options = field_rules.address_secondary):
 * - glued_indicator_spacing: UNIT100 -> UNIT 100, SUITE100 -> SUITE 100
 *   (the indicator word as received; # units are not changed);
 * - standalone_trailing_unit.after_street_name_without_suffix: a trailing
 *   number also splits after a street name without an English suffix
 *   (2245 CAMINO VIDA ROBLE 100), when the address starts with a house number,
 *   the street name has at least min_street_words words and its last word is
 *   not a highway word (HIGHWAY 101, STATE ROUTE 78 stay whole).
 */
function splitAddress(address, indicators, options = {}) {
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
  let m = text.match(withWord);
  if (m) {
    let suite = m[2].trim();
    const spacing = options.glued_indicator_spacing;
    if (spacing && spacing.enabled) {
      suite = suite.replace(new RegExp(`^((?:${words})\\.?)(?=#?[A-Z]?\\d)`, 'i'), `$1${spacing.separator ?? ' '}`);
    }
    return { street: m[1].trim(), suite };
  }
  m = text.match(withHash);
  if (m) return { street: m[1].trim(), suite: m[2].trim() };
  if (indicators.includes('standalone trailing unit')) {
    m = text.match(/^(.*\s(\S+))\s+([A-Z]?\d+[A-Z]?)$/i);
    if (m && STREET_SUFFIXES.includes(m[2].replace('.', '').toUpperCase())) return { street: m[1].trim(), suite: m[3] };
    const free = options.standalone_trailing_unit && options.standalone_trailing_unit.after_street_name_without_suffix;
    if (free && free.enabled) {
      m = text.match(/^(\d+[A-Z]?)\s+(.+)\s+([A-Z]?\d+[A-Z]?)$/i);
      if (m) {
        const streetWords = m[2].split(' ');
        const last = streetWords[streetWords.length - 1].replace(/\.$/, '').toUpperCase();
        const notAfter = (free.not_after || []).map((w) => w.toUpperCase());
        if (streetWords.length >= (free.min_street_words || 2) && !notAfter.includes(last)) {
          return { street: `${m[1]} ${m[2]}`, suite: m[3] };
        }
      }
    }
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

/** Tobi Tags from Comments, Assisted and the location names (TAG-CBLA-001, TAG-VI-001). */
function tobiTags(values, rule) {
  const text = rule.source_columns.map((c) => upper(values[c])).join(' | ');
  const tags = rule.rules
    .filter((r) => r.phrases.some((p) => new RegExp(`(^|[^A-Z])${escapeRe(p.toUpperCase())}([^A-Z]|$)`).test(text)))
    .map((r) => r.value);
  return joinUnique(tags, rule.delimiter);
}

function bookingNotes(comments, spaceType, rule, extra = []) {
  const parts = [comments];
  for (const r of rule.append_rules) {
    if (upper(spaceType) === String(r.when['Space Type']).toUpperCase()) parts.push(r.value);
  }
  parts.push(...extra); // e.g. "Nickname: MICHAEL" (CLIENT-NAME-NICKNAME-001), always last
  return joinUnique(parts, rule.delimiter);
}

/**
 * CLIENT-NAME-NICKNAME-001 (v2.8.1): removes nicknames written between the
 * delimiter pairs of the rule, e.g. ( ), [ ], " " or “ ”, with their delimiters.
 * A delimiter without its pair is removed and the text next to it is kept.
 * Returns the cleaned name and the nicknames found.
 */
function removeNicknames(value, rule) {
  let text = String(value ?? '');
  const nicknames = [];
  if (!rule) return { value: collapse(text), nicknames };
  for (const [open, close] of rule.pairs) {
    const re = new RegExp(`${escapeRe(open)}([^${escapeRe(open)}${escapeRe(close)}]*)${escapeRe(close)}`, 'g');
    text = text.replace(re, (_, inner) => {
      const nick = collapse(inner);
      if (nick) nicknames.push(nick);
      return ' ';
    });
  }
  for (const ch of new Set(rule.pairs.flat())) text = text.split(ch).join(' ');
  return { value: collapse(text).replace(/\s+,/g, ',').replace(/,\s+/g, ','), nicknames };
}

/** Booking Notes text for the nicknames of CLIENT-NAME-NICKNAME-001, or null. */
function nicknameNote(nicknames, rule) {
  if (!rule || !nicknames || !nicknames.length) return null;
  const note = rule.booking_note;
  return note.format.replace('{nicknames}', nicknames.join(note.nickname_separator));
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
  removeNicknames,
  nicknameNote,
  passengerIdentity,
  cleanWith,
  removeCharacters,
  cleanLegacyFirstName,
  appendOnce,
  collapse,
  upper,
  alnum,
  alnumClientId,
  isMissing,
  splitClientName,
  tobiMrn,
  withPrefix,
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
