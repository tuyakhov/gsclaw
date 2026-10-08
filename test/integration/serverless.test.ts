import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { unstable_startWorker } from 'wrangler';
import { ACCESS_TOKEN, serviceAccountJson } from '../helpers/setup.js';

type FetchHandler = (request: Request) => Promise<Response>;

async function listTools(handler: FetchHandler, base = 'https://gsclaw.test') {
  const client = new Client(
    { name: 'it', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
      fetch: (url, init) => handler(new Request(url, init)),
    }),
  );
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

describe('vercel adapter', () => {
  it('serves MCP from the fetch export using process.env', async () => {
    vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_JSON', serviceAccountJson());
    vi.stubEnv('GSCLAW_ACCESS_TOKEN', ACCESS_TOKEN);
    vi.stubEnv('LOG_LEVEL', 'silent');
    const { default: vercel } = await import('../../src/adapters/vercel.js');
    const health = await vercel.fetch(new Request('https://gsclaw.vercel.app/healthz'));
    expect(health.status).toBe(200);
    expect(await listTools((r) => vercel.fetch(r))).toContain('compare_periods');
    vi.unstubAllEnvs();
  });
});

describe('netlify adapter', () => {
  it('serves MCP using Netlify.env', async () => {
    const env = {
      GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
      GSCLAW_ACCESS_TOKEN: ACCESS_TOKEN,
      LOG_LEVEL: 'silent',
    };
    vi.stubGlobal('Netlify', { env: { toObject: () => env } });
    const { netlifyFetch } = await import('../../src/adapters/netlify.js');
    expect(await listTools(netlifyFetch)).toContain('page_report');
    vi.unstubAllGlobals();
  });
});

describe('cloudflare adapter (workerd via wrangler)', () => {
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;

  beforeAll(async () => {
    const { unstable_startWorker } = await import('wrangler');
    worker = await unstable_startWorker({
      config: 'wrangler.toml',
      bindings: {
        GOOGLE_SERVICE_ACCOUNT_JSON: { type: 'secret_text', value: serviceAccountJson() },
        GSCLAW_ACCESS_TOKEN: { type: 'secret_text', value: ACCESS_TOKEN },
        LOG_LEVEL: { type: 'plain_text', value: 'silent' },
      },
      dev: { server: { port: 0 }, inspector: false, logLevel: 'error' },
    });
    await worker.ready;
  }, 60_000);

  afterAll(() => worker?.dispose());

  it('bundles and runs the worker, serving health and MCP', async () => {
    const url = await worker.url;
    const health = await fetch(new URL('/healthz', url));
    expect(health.status).toBe(200);
    const tools = await listTools((r) => fetch(r), url.origin);
    expect(tools).toContain('striking_distance_keywords');
  });
});
