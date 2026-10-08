import { createApp, type App } from '../core/app.js';
import type { Env } from '../core/config.js';

interface NetlifyGlobal {
  env?: { toObject?: () => Record<string, string> };
}

let app: App | undefined;

function readEnv(): Env {
  const netlify = (globalThis as { Netlify?: NetlifyGlobal }).Netlify;
  return netlify?.env?.toObject?.() ?? process.env;
}

/** Netlify Functions (v2) handler; `netlify/functions/gsclaw.mjs` re-exports it with its route config. */
export function netlifyFetch(request: Request): Promise<Response> {
  app ??= createApp(readEnv(), { name: 'netlify' });
  return app.fetch(request);
}
