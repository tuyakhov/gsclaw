// Development demo: runs the real HTTP server and dashboard against the fake Search Console
// backend used by the tests (synthetic data for sc-domain:example.com). No Google account needed.
//
//   pnpm build && pnpm demo                    service-account mode; sign in with the token below
//   pnpm build && DEMO_AUTH=oauth pnpm demo    Google OAuth mode, with a stand-in Google sign-in page
//
// Then open http://127.0.0.1:3920.
import { serve } from 'srvx';
import { createStaticHandler, findStaticDir } from '../src/adapters/static.js';
import { createApp } from '../src/core/app.js';
import { formatConfigErrors, type Env } from '../src/core/config.js';
import { addDays, todayPT } from '../src/core/dates.js';
import { GOOGLE_AUTH_URL } from '../src/core/oauth/google.js';
import { buildFacts, createFakeGsc } from '../test/helpers/fake-gsc.js';
import { withFakeGoogle, type GoogleUser } from '../test/helpers/oauth.js';
import { DEMO_SERIES, demoShape } from './demo-data.js';
import { serviceAccountJson } from '../test/helpers/setup.js';

const PORT = Number(process.env.PORT ?? 3920);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'demo-token-0123456789abcdef0123456789abcdef';
const OAUTH = process.env.DEMO_AUTH === 'oauth';
const CLIENT_ID = 'demo-client.apps.googleusercontent.com';
const USERS: GoogleUser[] = [
  { sub: 'alice', email: 'alice@example.com' },
  { sub: 'mallory', email: 'mallory@elsewhere.dev' },
];

const fake = createFakeGsc({
  facts: buildFacts(addDays(todayPT(), -3), 480, { series: DEMO_SERIES, shape: demoShape }),
});
const google = withFakeGoogle(fake.fetch, USERS, CLIENT_ID, () => Math.floor(Date.now() / 1000));
// Google's APIs take a moment to answer; so does the demo, so loading states and latency look real.
const withLatency: typeof fetch = async (input, init) => {
  await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));
  return google.fetch(input, init);
};

const env: Env = OAUTH
  ? {
      GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: 'demo-client-secret',
      GSCLAW_ENCRYPTION_KEY: 'demo-encryption-key-0123456789abcdef0123456789',
      PUBLIC_BASE_URL: BASE,
      ALLOWED_GOOGLE_DOMAINS: 'example.com',
    }
  : {
      GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson({
        client_email: 'gsclaw-demo@example-project.iam.gserviceaccount.com',
      }),
      GSCLAW_ACCESS_TOKEN: TOKEN,
    };
env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

const staticDir = findStaticDir();
const app = createApp(env, {
  name: 'node',
  localOnly: true,
  fetch: withLatency,
  serveStatic: staticDir ? createStaticHandler(staticDir) : undefined,
});
if (app.setupErrors.length > 0) throw new Error(formatConfigErrors(app.setupErrors));

/** Stand-in for Google's account chooser: redirects back to the callback like Google would. */
function fakeGooglePage(url: URL): Response {
  const state = url.searchParams.get('state') ?? '';
  const back = (params: Record<string, string>) =>
    `/oauth/google/callback?${new URLSearchParams({ ...params, state }).toString()}`;
  const links = USERS.map(
    (u) => `<li><a href="${back({ code: `code-${u.sub}` })}">${u.email}</a></li>`,
  ).join('');
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Demo Google sign-in</title>
<body style="font:16px system-ui;max-width:420px;margin:15vh auto;padding:0 16px">
<h1 style="font-size:1.2rem">Demo Google sign-in</h1>
<p>This page stands in for accounts.google.com. Choose an account:</p><ul>${links}</ul>
<p><a href="${back({ error: 'access_denied' })}">Cancel</a></p></body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

const server = serve({
  port: PORT,
  hostname: '127.0.0.1',
  silent: true,
  async fetch(request) {
    const url = new URL(request.url);
    if (OAUTH && url.pathname === '/__demo/google') return fakeGooglePage(url);
    const response = await app.fetch(request);
    // Send the browser to the stand-in page instead of the real Google sign-in.
    const location = response.headers.get('location');
    if (OAUTH && location?.startsWith(GOOGLE_AUTH_URL)) {
      const headers = new Headers(response.headers);
      headers.set('location', `/__demo/google${new URL(location).search}`);
      return new Response(null, { status: response.status, headers });
    }
    return response;
  },
});
await server.ready();

console.log(
  OAUTH
    ? `GSClaw demo (Google OAuth mode) running at ${BASE}\nSign in as alice@example.com (allowed) or mallory@elsewhere.dev (not allowed).`
    : `GSClaw demo running at ${BASE}\nAccess token: ${TOKEN}`,
);
