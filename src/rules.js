'use strict';

// Loads the parsing rules from the JSON file in config/rules/.
// The JSON is the single source of truth: defaults, phrases and mappings are
// read from it instead of being hard-coded.
//
// A rules file can be an overlay (v2.6.0+): "specification.extends" names the
// base file, which is deep-merged by key (objects merge, other values and
// arrays are replaced), and the "*_patch" keys are applied on top.

const fs = require('node:fs');
const path = require('node:path');

const RULES_DIR = path.join(__dirname, '..', 'config', 'rules');
const RULES_FILE = process.env.RULES_FILE
  || path.join(RULES_DIR, 'nctd_manifest_parser_rules_v2.10.0.json');

let cached = null;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function deepMerge(base, over) {
  if (!isObject(base) || !isObject(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function insertAfter(list, after, item, what) {
  const i = list.indexOf(after);
  if (i === -1) throw new Error(`Rules overlay: "${after}" not found in ${what}`);
  if (list.includes(item)) return list;
  return [...list.slice(0, i + 1), item, ...list.slice(i + 1)];
}

/** Finds the base file next to the overlay, or in archive/. */
function resolveBase(name, dir) {
  for (const p of [path.join(dir, name), path.join(dir, 'archive', name), path.join(RULES_DIR, name), path.join(RULES_DIR, 'archive', name)]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Rules overlay: base file ${name} not found`);
}

/** Replaces entries with the same id where they are; appends the new ones. */
function upsertById(list = [], patch, key) {
  const out = [...list];
  for (const item of patch) {
    const i = out.findIndex((x) => x[key] === item[key]);
    if (i === -1) out.push(item); else out[i] = item;
  }
  return out;
}

const PATCHES = {
  // one { after, column } or, since v2.10.0, a list of them applied in order
  destination_columns_patch(r, p) {
    for (const x of [].concat(p)) r.destination_columns = insertAfter(r.destination_columns, x.after, x.column, 'destination_columns');
  },
  processing_pipeline_patch(r, p) {
    r.processing_pipeline = insertAfter(r.processing_pipeline, p.after, p.step, 'processing_pipeline');
  },
  validations_patch(r, p) { r.validations = upsertById(r.validations, p, 'validation_id'); },
  acceptance_tests_patch(r, p) { r.acceptance_tests = upsertById(r.acceptance_tests, p, 'id'); },
  exceptions_patch(r, p) { r.exceptions = { ...r.exceptions, ...p }; },
  consistency_contract_patch(r, p) { r.consistency_contract = deepMerge(r.consistency_contract || {}, p); },
  export_gate_patch(r, p) { r.file_contract.export_gate = deepMerge(r.file_contract.export_gate || {}, p); },
};

function readRules(file) {
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ext = json.specification && json.specification.extends;
  if (!ext) return json;
  const base = readRules(resolveBase(ext.file, path.dirname(file)));
  const plain = Object.fromEntries(Object.entries(json).filter(([k]) => !k.endsWith('_patch')));
  const merged = deepMerge(base, plain);
  // the history keeps every version: overlay entries first, then the base
  // (an overlay may repeat entries of its base: keep the first one of each version)
  const seen = new Set();
  merged.specification.changelog = [...(json.specification.changelog || []), ...(base.specification.changelog || [])]
    .filter((c) => !seen.has(c.version) && seen.add(c.version));
  for (const [key, patch] of Object.entries(json)) {
    if (!key.endsWith('_patch')) continue;
    if (!PATCHES[key]) throw new Error(`Rules overlay: unknown patch ${key}`);
    PATCHES[key](merged, patch);
  }
  return merged;
}

function loadRules(file = RULES_FILE) {
  if (cached && file === RULES_FILE) return cached;
  const rules = readRules(file);
  if (file === RULES_FILE) cached = rules;
  return rules;
}

module.exports = { loadRules, readRules, deepMerge, RULES_FILE };
