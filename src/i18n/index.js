'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LANGS = ['es', 'en'];
const DEFAULT_LANG = 'es';
const dictionaries = Object.fromEntries(LANGS.map((l) => [
  l,
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'locales', `${l}.json`), 'utf8')),
]));

function pickLang(req) {
  const q = String(req.query.lang || '').toLowerCase();
  if (LANGS.includes(q)) return q;
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim().split('='));
  const fromCookie = (cookie.find(([k]) => k === 'lang') || [])[1];
  if (LANGS.includes(fromCookie)) return fromCookie;
  return DEFAULT_LANG;
}

function translator(lang) {
  const dict = dictionaries[lang] || dictionaries[DEFAULT_LANG];
  return (key, vars = {}) => String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `{${k}}`));
}

module.exports = { LANGS, DEFAULT_LANG, dictionaries, pickLang, translator };
