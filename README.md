# NCTD Manifest Parser

WebApp en Node.js y Express que convierte el manifiesto de viajes de North County Transit District ("Viajes") en el CSV de importación de TOBI ("Output"). Aplica las reglas de `config/rules/nctd_manifest_parser_rules_v2.8.3.json`. Es una cadena de capas: v2.8.3 → v2.8.2 → v2.8.1 → v2.8.0 → v2.7.1 → v2.7.0 → v2.6.0 → v2.5.0. La App carga la v2.5.0 y le aplica en orden los cambios de cada capa. Por eso las ocho versiones deben estar en `config/rules/`.

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

Con el catálogo en la base de datos de pruebas (lee `.env`, ver abajo):

```bash
npm run dev:db
```

Pruebas (casos AT del JSON, matriz TC-001 a TC-028 de la v2.0 y pruebas de campos e ingesta):

```bash
npm test
```

## Catálogo en base de datos (DynamoDB, regla CATALOG-STORAGE-001, v2.8.3)

Sin variables de entorno la App funciona como siempre: el catálogo es el CSV que se sube cada día. Con estas variables el catálogo vive en una tabla de DynamoDB y la App lo lee sola:

| Variable | Valor |
| --- | --- |
| `CATALOG_STORE` | `dynamodb` (`memory` para probar sin AWS; no guarda nada al reiniciar) |
| `CATALOG_TABLE` | `nctd-passengers-prod` en Render, `nctd-passengers-stage` para pruebas |
| `AWS_REGION` | `us-east-2` (Ohio, donde están las tablas) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Llave del usuario de IAM de esa tabla |
| `CATALOG_ACCESS_KEY` | Clave que se escribe en la App para leer o cambiar el catálogo |

Sin `CATALOG_ACCESS_KEY` la App no arranca en modo base de datos, porque la URL es pública. Para trabajar en tu computadora copia `.env.example` a `.env` (no se sube a git) y usa `npm run dev:db`.

Cómo funciona:

- Al procesar, la App lee toda la tabla y la aplica igual que un catálogo subido (CATALOG-001, con sus migraciones).
- Procesar no escribe nada. Después de revisar el resultado, el botón **Guardar en catálogo** escribe los pasajeros nuevos. Hazlo antes de llevar el Output a TOBI.
- Cada pasajero se escribe con una condición (`attribute_not_exists`): si el MRN ya existe, nunca se sobrescribe. Si otro proceso guardó el mismo pasajero mientras revisabas, la App lo avisa y pide volver a procesar.
- **Importar un CSV:** carga un `NCTD_Passengers_<AAAAMMDD>_UPDTD.csv` a la tabla (se usa para la carga inicial). Aplica las migraciones; los MRN que ya están se conservan.
- **Descargar respaldo:** exporta toda la tabla como CSV. La descarga "Pasajeros actualizado" de cada proceso también sigue.

Tabla: llave de partición `mrn` (String, MRN solo con letras y números en mayúsculas, `82475PCA`); atributos `firstName`, `lastName`, `mrnNumber`, `telephone`, `addedAt`, `ord` y `source`. Capacidad aprovisionada, clase DynamoDB Standard: prod 10/10 y stage 5/5, dentro del nivel siempre gratuito de AWS (25 GB, 25 RCU y 25 WCU por región).

Permisos del usuario de IAM (uno por tabla; cambia `<CUENTA>` y el nombre de la tabla):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem"],
    "Resource": "arn:aws:dynamodb:us-east-2:<CUENTA>:table/nctd-passengers-prod"
  }]
}
```

## Uso

1. **Sección 1:** carga Viajes (`.xlsx` o `.csv`) y el catálogo de Pasajeros (`.csv`, el `NCTD_Passengers_<AAAAMMDD>_UPDTD.csv` del día anterior). Cada archivo se muestra en su datagrid.
2. Opcional: marca "Cambiar la fecha de los viajes", elige la nueva fecha y pulsa "Cambiar la fecha". Cambian Trip Date, Pickup Time, Dropoff Time, Vendor ID y Leg ID (regla `trip_date_override`).
3. Pulsa "Procesar la información".
4. **Sección 2:** revisa el resumen y Output, busca por First Name, Last Name o Tobi MRN y descarga:
   - `<Viajes>_TOBI.csv` (solo si no hay colisiones de ID ni emparejamientos ambiguos; si los hay, la exportación se bloquea)
   - `NCTD_Passengers_<AAAAMMDD>_UPDTD.csv` (fecha del día de proceso, hora de la Ciudad de México)
   - `<Viajes>_INVALID_TRIPS.csv` (solo si hay filas inválidas o con excepción)

## Estructura

```text
server.js                      Servidor Express (puerto 3600)
config/rules/                  Reglas en JSON (fuente única de reglas)
src/parser/ingestion.js        Lectura de XLSX y CSV
src/parser/pipeline.js         Validación, duplicados, emparejamiento A/B, Vendor ID, Leg ID, colisiones y mapeo
src/parser/fields.js           Reglas por campo (nombre, MRN, direcciones, teléfonos, tags, etc.)
src/parser/dates.js            Fechas y horas
src/parser/pasajeros.js        Catálogo maestro de Pasajeros
src/catalog-store.js           Catálogo en DynamoDB (o en memoria para pruebas)
src/parser/csv-export.js       CSV con BOM UTF-8
src/routes/api.js              API REST
locales/                       Textos en español e inglés
views/index.ejs                Página
public/                        CSS, JS del navegador y logo
test/                          Pruebas (fixtures/ contiene la matriz TC v2.0)
```

## API

| Método | Ruta | Uso |
| --- | --- | --- |
| POST | `/api/uploads/viajes` | Carga Viajes (campo `file`) |
| POST | `/api/uploads/pasajeros` | Carga Pasajeros (campo `file`) |
| POST | `/api/uploads/:uploadId/trip-date` | `{ "newDate": "YYYY-MM-DD" }` vista previa con la fecha cambiada |
| POST | `/api/jobs` | `{ viajesUploadId, pasajerosUploadId?, newTripDate? }` procesa (en modo base de datos, con `X-Catalog-Key` y sin `pasajerosUploadId`) |
| GET | `/api/jobs/:jobId/output` | Descarga Output |
| GET | `/api/jobs/:jobId/pasajeros` | Descarga Pasajeros actualizado |
| GET | `/api/jobs/:jobId/invalid-trips` | Descarga Invalid Trips |
| GET | `/api/jobs/:jobId/search?q=` | Busca en First Name, Last Name y Tobi MRN |
| GET | `/api/catalog/status` | Modo del catálogo (`csv` o `dynamodb`) y tabla |
| GET | `/api/catalog` | Catálogo de la base de datos (encabezado `X-Catalog-Key`) |
| POST | `/api/catalog/import` | Importa un CSV de Pasajeros a la base de datos (campo `file`, `X-Catalog-Key`) |
| GET | `/api/catalog/export` | Respaldo CSV de la base de datos (`X-Catalog-Key`) |
| POST | `/api/jobs/:jobId/catalog` | Guarda en la base de datos los pasajeros nuevos del proceso (`X-Catalog-Key`) |
| GET | `/healthz` | Estado, versión de reglas y modo del catálogo |

## Notas

- **Extensión `.csv` en minúsculas:** todos los CSV de salida la usan porque TOBI no reconoce `.CSV`.

- **Datos personales:** los archivos cargados y los resultados viven solo en memoria y se descartan a las 2 horas. No se escriben en disco. En modo base de datos, el catálogo (nombre, MRN y teléfono) se guarda en DynamoDB, que lo cifra en reposo.
- **Identificadores (reglas v2.0.0):** Vendor ID `{Client ID}{YYYYMMDD}{HHMM}[PCA]` y Leg ID `{Vendor ID}{A|B}`, solo letras y números. Son determinísticos: reprocesar el mismo archivo da los mismos IDs, sin registro ni secuencias. Una colisión o un emparejamiento ambiguo bloquea la exportación de Output.
- **Catálogo maestro de Pasajeros (regla CATALOG-001):** sube cada día el `NCTD_Passengers_<AAAAMMDD>_UPDTD.csv` del día anterior. Si el pasajero ya está en el catálogo, First Name, Last Name y Primary Phone se toman de ahí y nunca cambian, para no crear alias en TOBI. Los pasajeros nuevos, incluidos los acompañantes (`82475PCA`), se agregan al final con los datos del primer viaje en que aparecen (sin teléfono: `8584020500`, desde la v2.8.2; antes `9876543210`). Al subir un catálogo, las filas que todavía tengan `9876543210` cambian a `8584020500` (regla CATALOG-PHONE-MIGRATION-001) y el resumen muestra cuántas cambiaron. Si no se sube el catálogo, la App avisa que todos se trataron como nuevos.
- **Leg ID V2 consecutivo (regla LEG-ID-V2-SEQUENTIAL-001, v2.8.0):** la casilla "Asignar números consecutivos a Leg ID V2" reemplaza el Leg ID V2 de cada viaje del Output por `L000001`, `L000002`… en el orden del archivo, empezando en el número del campo "Iniciar en" (1 por defecto). Para no repetir números en TOBI, cada archivo debe empezar en el número siguiente al último del anterior; el aviso de exportación muestra con cuál seguir. Vendor ID, Leg ID, Tobi MRN, Pair Status y el catálogo no cambian. Si la numeración pasara de `L999999`, el Output no se genera (`LEG_ID_V2_SEQUENCE_OVERFLOW`).
- **Acompañantes (reglas v2.7.0 y v2.7.1):** PCA y COM son identidades distintas; COMP se trata como COM. Tobi MRN, Vendor ID y Leg ID usan `PCA` o `COM` sin guiones (`3333PCA`, `3333COM`, `…COMA`). El First Name lleva `-PCA` o `-COM` una sola vez y el Last Name no lleva sufijo (`LOPEZ,MARIA` PCA → `LOPEZ` / `MARIA-PCA`). Un PCA nunca se empareja con un COM. Si el manifiesto trae sufijos viejos (`ALLOUCHE COMPANION,DEANNE - PCA`), se quitan una vez. Al subir un catálogo, las filas de acompañantes con el formato anterior se corrigen (CATALOG-NAME-MIGRATION-003). Los catálogos generados antes de la v2.7.0 se descartan y el catálogo se regenera desde el manifiesto del 23 de octubre.
- **Leg ID V2 (regla experimental LEG-ID-V2-EXPERIMENTAL-001, v2.6.0):** el Output lleva la columna `Leg ID V2` después de `Leg ID` (33 columnas). En clientes (CLI) copia el Leg ID; en acompañantes (PCA, COM, COMP) copia el Vendor ID. Vendor ID, Leg ID, Tobi MRN y Pair Status no cambian. La casilla "Modo experimental Leg ID V2 (solo TOBI Stage)" activa el modo `TOBI_INDEPENDENT_LEGS_V2`: con ella, un Leg ID V2 repetido o inválido bloquea el Output; sin ella solo se avisa. El archivo Output es el mismo en los dos modos; en TOBI Stage se elige Leg ID V2 como identificador del tramo. No se usa en PROD.
- **Apodos en Client Name (regla CLIENT-NAME-NICKNAME-001, v2.8.1):** un apodo entre `( )`, `[ ]`, `" "` o `“ ”` se quita del nombre junto con sus delimitadores, porque TOBI usa el nombre como llave y el apodo crearía alias. `MATTHEWS,SCOTT  (MICHAEL)` queda como `MATTHEWS` / `SCOTT`, y el apodo se agrega al final de Booking Notes como `Nickname: MICHAEL`. Las comillas simples no se tocan (`O'BRIEN`). Si el nombre queda vacío, la fila va a Invalid Trips, que muestra el nombre original.
- **Caracteres especiales en direcciones (regla SOURCE-SPECIAL-CHARS-001, v2.5.0; desde la v2.8.1 ya no aplica a Client Name):** antes de validar se quitan `( ) [ ]` de PUAddress, PUCity, PUZipcode, DOAddress, DOCity y DOZipcode, y el texto de adentro se conserva (`200 MISSION AVE (STE 5)` → suite `STE 5`).
- **Client Name (regla CLIENT-NAME-FORMAT-001, v2.4.0):** debe venir como `APELLIDO,NOMBRE`. Si no trae coma, o le falta el apellido o el nombre, la fila va a Invalid Trips con `INVALID_CLIENT_NAME_FORMAT` y el resto del archivo se exporta normal.
- **Acompañantes (PCA, COM, COMP; reglas v2.3.0, reemplazadas por la v2.7.0):** el First Name se deja tal cual, sin `" - PCA"`, y el Last Name termina en `" COMPANION"` una sola vez. `PCA` se conserva solo en Tobi MRN, Vendor ID y Leg ID (`PCAA`/`PCAB`). Si el manifiesto o un catálogo anterior trae `"DEANNE - PCA"`, se corrige a `DEANNE` (migración CATALOG-PCA-FIRSTNAME-MIGRATION-001) y el resumen muestra cuántos acompañantes se corrigieron.
- **Lectura de XLSX:** se usa ExcelJS. SheetJS no se usa porque la versión publicada en npm (0.18.5) tiene vulnerabilidades sin corregir.
- **Sin autenticación de usuarios:** pensada para uso interno. En modo base de datos, leer o cambiar el catálogo y procesar piden la clave `CATALOG_ACCESS_KEY`; en modo CSV no hay clave.
