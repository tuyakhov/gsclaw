import { createApp, type App } from '../core/app.js';

let app: App | undefined;

/**
 * Vercel Function (Node.js runtime, Fluid Compute) using the web-standard `fetch` export.
 * `api/index.js` re-exports this, and vercel.json rewrites every path to it.
 */
export default {
  fetch(request: Request): Promise<Response> {
    app ??= createApp(process.env, { name: 'vercel' });
    return app.fetch(request);
  },
};
