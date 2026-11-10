# NCTD Manifest Parser

WebApp en Node.js y Express que convierte el manifiesto de viajes de North County Transit District ("Viajes") en el CSV de importación de TOBI ("Output"). Aplica las reglas de `config/rules/nctd_manifest_parser_rules_v1.4.0.json`.

## Requisitos

- Node.js 22 o superior
- npm

## Instalación y arranque

```bash
npm install
npm start
```

La App escucha en **http://localhost:3600**. Para otro puerto: `PORT=4000 npm start`.

Modo desarrollo, que reinicia el servidor al guardar cambios:

```bash
npm run dev
```

Pruebas (AT-01 a AT-17 del JSON, más pruebas de campos e ingesta):

```bash
npm test
```

## Uso

1. **Sección 1:** carga Viajes (`.xlsx` o `.csv`) y Pasajeros (`.csv`). Cada archivo se muestra en su datagrid.
2. Opcional: marca "Cambiar la fecha de los viajes", elige la nueva fecha y pulsa "Cambiar la fecha". Cambian Trip Date, Pickup Time, Dropoff Time, Journey ID y Leg ID (regla `trip_date_override`).
3. Pulsa "Procesar la información".
4. **Sección 2:** revisa el resumen y Output, busca por First Name, Last Name o Tobi MRN y descarga:
   - `<Viajes>_TOBI.CSV`
   - `<Pasajeros>_UPDATED.CSV`
   - `<Viajes>_INVALID_TRIPS.CSV` (solo si hay filas inválidas o con excepción)

## Estructura

```text
server.js                      Servidor Express (puerto 3600)
config/rules/                  Reglas en JSON (fuente única de reglas)
src/parser/ingestion.js        Lectura de XLSX y CSV
src/parser/pipeline.js         Validación, duplicados, tramos, journeys, IDs y mapeo
src/parser/fields.js           Reglas por campo (nombre, MRN, direcciones, teléfonos, tags, etc.)
src/parser/dates.js            Fechas y horas
src/parser/pasajeros.js        Actualización de Pasajeros (PROVISIONAL)
src/parser/csv-export.js       CSV con BOM UTF-8
src/registry/json-registry.js  Registro de Journey ID (archivo JSON)
src/routes/api.js              API REST
locales/                       Textos en español e inglés
views/index.ejs                Página
public/                        CSS, JS del navegador y logo
test/                          Pruebas con datos ficticios
```

## API

| Método | Ruta | Uso |
| --- | --- | --- |
| POST | `/api/uploads/viajes` | Carga Viajes (campo `file`) |
| POST | `/api/uploads/pasajeros` | Carga Pasajeros (campo `file`) |
| POST | `/api/uploads/:uploadId/trip-date` | `{ "newDate": "YYYY-MM-DD" }` vista previa con la fecha cambiada |
| POST | `/api/jobs` | `{ viajesUploadId, pasajerosUploadId?, newTripDate? }` procesa |
| GET | `/api/jobs/:jobId/output` | Descarga Output |
| GET | `/api/jobs/:jobId/pasajeros` | Descarga Pasajeros actualizado |
| GET | `/api/jobs/:jobId/invalid-trips` | Descarga Invalid Trips |
| GET | `/api/jobs/:jobId/search?q=` | Busca en First Name, Last Name y Tobi MRN |
| GET | `/healthz` | Estado y versión de reglas |

## Notas

- **Datos personales:** los archivos cargados y los resultados viven solo en memoria y se descartan a las 2 horas. No se escriben en disco.
- **Registro de Journey ID:** `data/journey-registry.json` guarda la secuencia diaria y las huellas de journeys por 72 horas, para reutilizar el mismo Journey ID al reprocesar. Es adecuado para un solo proceso; para varios servidores se debe pasar a PostgreSQL. Borrar ese archivo reinicia las secuencias.
- **Pasajeros:** la actualización es **provisional** mientras se definen sus reglas. Agrega a cada cliente (CLI) cuyo Client ID no está en `MRN Number`. Toda esa lógica está en `src/parser/pasajeros.js`.
- **Lectura de XLSX:** se usa ExcelJS. SheetJS no se usa porque la versión publicada en npm (0.18.5) tiene vulnerabilidades sin corregir.
- **Sin autenticación:** pensada para uso interno; no exponerla a Internet sin agregar acceso con usuario.
