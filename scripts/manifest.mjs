#!/usr/bin/env node
// Keeps the contributor-only `preinstall` guard (`npx only-allow pnpm`) out of the published
// package. only-allow cannot tell `npx gsclaw` apart from a contributor running `npm install`,
// so shipping it would break installs for end users.
//
//   node scripts/manifest.mjs strip    (prepack)  removes scripts.preinstall, keeps a backup
//   node scripts/manifest.mjs restore  (postpack) restores package.json from the backup
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const MANIFEST = new URL('../package.json', import.meta.url);
const BACKUP = new URL('../package.json.prepack', import.meta.url);

const command = process.argv[2];

if (command === 'strip') {
  copyFileSync(MANIFEST, BACKUP);
  const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  delete pkg.scripts?.preinstall;
  writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 2)}\n`);
} else if (command === 'restore') {
  if (existsSync(BACKUP)) renameSync(BACKUP, MANIFEST);
} else {
  console.error('usage: manifest.mjs <strip|restore>');
  process.exit(1);
}
