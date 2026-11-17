'use strict';

const path = require('node:path');
const express = require('express');
const { loadRules } = require('./src/rules');
const { TtlStore } = require('./src/store');
const { createApiRouter } = require('./src/routes/api');
const { storeFromEnv } = require('./src/catalog-store');
const { dictionaries, pickLang, translator, LANGS } = require('./src/i18n');

const PORT = Number(process.env.PORT) || 3600;
const HOST = process.env.HOST || '0.0.0.0';
const RESULT_TTL_MS = 2 * 60 * 60 * 1000; // uploaded and generated files live 2 hours

function createApp({ rules = loadRules(), catalogStore = storeFromEnv(), accessKey = process.env.CATALOG_ACCESS_KEY || '' } = {}) {
  const app = express();
  const uploads = new TtlStore(RESULT_TTL_MS);
  const jobs = new TtlStore(RESULT_TTL_MS);

  app.disable('x-powered-by');
  // Render terminates HTTPS in front of the App: req.secure and req.ip come
  // from X-Forwarded-Proto / X-Forwarded-For (needed for the Secure cookie).
  app.set('trust proxy', 1);
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
      catalogMode: catalogStore ? catalogStore.kind : 'csv',
      catalogTable: catalogStore ? catalogStore.table : '',
    });
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, rulesVersion: rules.specification.version, catalog: catalogStore ? catalogStore.kind : 'csv' }));

  app.use('/api', createApiRouter({ rules, uploads, jobs, catalogStore, accessKey }));
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    const store = process.env.CATALOG_STORE ? `catalog: ${process.env.CATALOG_STORE} ${process.env.CATALOG_TABLE}` : 'catalog: CSV upload';
    console.log(`NCTD Manifest Parser listening on http://localhost:${PORT} (${store})`);
  });
}

module.exports = { createApp };
