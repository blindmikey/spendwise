// Build a db.json from the legacy archive for manual/visual testing:
//   node tests/make-import-db.mjs <output-path>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importLegacy } from '../src/main/migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2];
if (!out) { console.error('usage: node tests/make-import-db.mjs <output-path>'); process.exit(1); }

const { data, summary } = importLegacy(path.join(here, '../archive/old-finances-app/data'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log('written to ' + out);
