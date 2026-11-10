'use strict';

// Loads the parsing rules from the JSON file in config/rules/.
// The JSON is the single source of truth: defaults, phrases and mappings are
// read from it instead of being hard-coded.

const fs = require('node:fs');
const path = require('node:path');

const RULES_FILE = process.env.RULES_FILE
  || path.join(__dirname, '..', 'config', 'rules', 'nctd_manifest_parser_rules_v1.4.0.json');

let cached = null;

function loadRules(file = RULES_FILE) {
  if (cached && file === RULES_FILE) return cached;
  const rules = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (file === RULES_FILE) cached = rules;
  return rules;
}

module.exports = { loadRules, RULES_FILE };
