#!/usr/bin/env node
// Prepares dist/public, the static directory served by Vercel/Netlify/Cloudflare and the Node
// server. index.html is never placed here: `/` is always handled by the app so it can gate the
// dashboard and show the setup page.
import { mkdirSync, writeFileSync } from 'node:fs';

const dir = new URL('../dist/public/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('robots.txt', dir), 'User-agent: *\nDisallow: /\n');
