import { createApp, type App } from '../core/app.js';
import type { Env } from '../core/config.js';

// One app per isolate. Workers pass the same `env` object to every request in an isolate.
const apps = new WeakMap<object, App>();

/** Vars and secrets arrive as strings; other bindings (KV, assets…) are skipped. */
function stringEnv(env: Record<string, unknown>): Env {
  const out: Env = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

/** Cloudflare Workers entrypoint (module syntax). Bundled by wrangler from this source file. */
export default {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    let app = apps.get(env);
    if (!app) {
      app = createApp(stringEnv(env), { name: 'cloudflare' });
      apps.set(env, app);
    }
    return app.fetch(request);
  },
};
