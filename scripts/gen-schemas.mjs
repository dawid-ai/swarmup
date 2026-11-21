// Writes the JSON Schemas of the definition files (swarm.yaml, agent frontmatter) to
// packages/core/schemas/, from the schema language in packages/core/src/defs. Run it after
// changing a schema there; `packages/core/test/defs-schemas.test.ts` fails while the files are
// out of date.
//
// Usage: pnpm run build && node scripts/gen-schemas.mjs

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const top = join(dirname(fileURLToPath(import.meta.url)), '..');
const core = join(top, 'packages', 'core', 'dist', 'index.js');
const { schemaFiles } = await import(pathToFileURL(core).href);
const dir = join(top, 'packages', 'core', 'schemas');
mkdirSync(dir, { recursive: true });
const files = schemaFiles();
for (const name of readdirSync(dir)) {
  if (name.endsWith('.schema.json') && !(name in files)) rmSync(join(dir, name));
}
for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(dir, name), text);
  console.log(`wrote packages/core/schemas/${name}`);
}
