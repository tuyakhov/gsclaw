// Development demo: runs the real HTTP server and dashboard against the fake Search Console
// backend used by the tests (synthetic data for sc-domain:example.com). No Google account needed.
//
//   pnpm build && pnpm demo        then open http://127.0.0.1:3920 and sign in with the token below
import { startNodeServer } from '../src/adapters/node-http.js';
import { addDays, todayPT } from '../src/core/dates.js';
import { buildFacts, createFakeGsc } from '../test/helpers/fake-gsc.js';
import { serviceAccountJson } from '../test/helpers/setup.js';

const TOKEN = 'demo-token-0123456789abcdef0123456789abcdef';
const fake = createFakeGsc({ facts: buildFacts(addDays(todayPT(), -3), 480) });

const server = await startNodeServer({
  port: Number(process.env.PORT ?? 3920),
  host: '127.0.0.1',
  fetch: fake.fetch,
  env: {
    GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson({
      client_email: 'gsclaw-demo@example-project.iam.gserviceaccount.com',
    }),
    GSCLAW_ACCESS_TOKEN: TOKEN,
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  },
});

console.log(`GSClaw demo running at ${server.url}\nAccess token: ${TOKEN}`);
