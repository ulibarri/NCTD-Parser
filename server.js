'use strict';

const path = require('node:path');
const express = require('express');
const { loadRules } = require('./src/rules');
const { JsonRegistry } = require('./src/registry/json-registry');
const { TtlStore } = require('./src/store');
const { createApiRouter } = require('./src/routes/api');
const { dictionaries, pickLang, translator, LANGS } = require('./src/i18n');

const PORT = Number(process.env.PORT) || 3600;
const HOST = process.env.HOST || '0.0.0.0';
const RESULT_TTL_MS = 2 * 60 * 60 * 1000; // uploaded and generated files live 2 hours

function createApp({ rules = loadRules(), registryFile = process.env.REGISTRY_FILE || path.join(__dirname, 'data', 'journey-registry.json') } = {}) {
  const app = express();
  const registry = new JsonRegistry(registryFile, { retentionHours: rules.journey_leg_rules.fingerprint.retention_hours });
  const uploads = new TtlStore(RESULT_TTL_MS);
  const jobs = new TtlStore(RESULT_TTL_MS);

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  app.use(express.static(path.join(__dirname, 'public')));
  const modules = path.join(__dirname, 'node_modules');
  app.use('/vendor/pico', express.static(path.join(modules, '@picocss', 'pico', 'css')));
  app.use('/vendor/tabulator', express.static(path.join(modules, 'tabulator-tables', 'dist')));

  app.get('/', (req, res) => {
    const lang = pickLang(req);
    res.render('index', {
      lang,
      langs: LANGS,
      t: translator(lang),
      i18nJson: JSON.stringify(dictionaries).replace(/</g, '\\u003c'),
      rulesVersion: rules.specification.version,
      destinationColumns: rules.destination_columns,
    });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, rulesVersion: rules.specification.version }));

  app.use('/api', createApiRouter({ rules, registry, uploads, jobs }));
  return app;
}

if (require.main === module) {
  createApp().listen(PORT, HOST, () => {
    console.log(`NCTD Manifest Parser listening on http://localhost:${PORT}`);
  });
}

module.exports = { createApp };
