#!/usr/bin/env node
// Builds the dashboard into dist/public, the static directory served by every target
// (Vercel/Netlify/Cloudflare CDNs, or the Node server). Asset names are fixed and cache-busted with
// the package version by the HTML shell in src/core/dashboard-shell.ts; index.html is never
// written here because `/` must always go through the app (login gate, setup page, kill switch).
//
//   node scripts/build-dashboard.mjs           production build (minified, size budget enforced)
//   node scripts/build-dashboard.mjs --watch   rebuild on change
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { build, context } from 'esbuild';

const root = new URL('../', import.meta.url);
const outdir = new URL('dist/public/assets/', root);
const watch = process.argv.includes('--watch');
const BUDGET_GZIP_BYTES = 100 * 1024;

mkdirSync(outdir, { recursive: true });
writeFileSync(new URL('dist/public/robots.txt', root), 'User-agent: *\nDisallow: /\n');
copyFileSync(new URL('assets/logo.svg', root), new URL('favicon.svg', outdir));

/** @type {import('esbuild').BuildOptions} */
const options = {
  absWorkingDir: new URL('.', root).pathname,
  entryPoints: { dashboard: 'dashboard/src/main.tsx' },
  outdir: 'dist/public/assets',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  let total = 0;
  for (const file of ['dashboard.js', 'dashboard.css']) {
    const gz = gzipSync(readFileSync(new URL(file, outdir))).length;
    total += gz;
    console.log(`  ${file.padEnd(16)} ${(gz / 1024).toFixed(1)} KB gzipped`);
  }
  console.log(
    `  total            ${(total / 1024).toFixed(1)} KB gzipped (budget ${BUDGET_GZIP_BYTES / 1024} KB)`,
  );
  if (total > BUDGET_GZIP_BYTES) {
    console.error('Dashboard bundle exceeds its size budget.');
    process.exit(1);
  }
}
