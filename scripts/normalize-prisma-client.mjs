#!/usr/bin/env node
/**
 * Normalize the Prisma 7 generated client to CJS-safe TypeScript.
 *
 * Prisma 7.9.1's `prisma-client` generator emits ESM-flavored TS:
 *   - explicit `.ts` import/export extensions (`from "./internal/class.ts"`)
 *   - an `import.meta.url`-based `__dirname` shim in client.ts
 *
 * When `tsc` (module: commonjs) compiles that, the emitted `require()` keeps
 * the `.ts` suffix but only `.js` files land in `dist/` → "Cannot find module"
 * at runtime. This script strips the `.ts` extensions from *relative* specifiers
 * and removes the `import.meta` shim, so the compiled output matches older
 * Prisma 7.x patches and resolves cleanly under `node dist/src/main`.
 *
 * Idempotent — safe to run on already-normalized output. Only relative
 * specifiers (`./`, `../`) are touched; bare package imports are left alone.
 *
 * Usage: node scripts/normalize-prisma-client.mjs <generated-dir>
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

async function listTs(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listTs(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/normalize-prisma-client.mjs <generated-dir>');
  process.exit(1);
}

let strippedExtensions = 0;
let removedShim = 0;

for (const file of await listTs(target)) {
  const src = await readFile(file, 'utf8');
  let out = src;

  // 1+2. Remove the import.meta.url __dirname shim (only present in client.ts).
  if (file.endsWith('client.ts')) {
    const before = out;
    out = out
      .replace(/^import \{ fileURLToPath \} from 'node:url'\r?\n/m, '')
      .replace(/^globalThis\['__dirname'\] = .*import\.meta\.url.*\r?\n/m, '');
    if (out !== before) removedShim += 1;
  }

  // 3. Strip `.ts` from relative import/export specifiers (single or double
  //    quoted, with or without `type`).
  const extRe =
    /((?:import|export)(?:\s+type)?\s[^;]*?\sfrom\s+)(['"])(\.{1,2}\/[^'"]*?)\.ts\2/g;
  const beforeExt = out;
  out = out.replace(extRe, (_m, head, quote, spec) => `${head}${quote}${spec}${quote}`);
  if (out !== beforeExt) strippedExtensions += 1;

  if (out !== src) await writeFile(file, out);
}

console.log(
  `normalize-prisma-client: stripped .ts extensions in ${strippedExtensions} file(s), ` +
    `removed import.meta shim in ${removedShim} file(s).`,
);