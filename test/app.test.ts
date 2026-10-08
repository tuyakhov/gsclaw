import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/core/app.js';
import type { Env } from '../src/core/config.js';
import { createFakeGsc, TEST_NOW } from './helpers/fake-gsc.js';
import { ACCESS_TOKEN, testEnv } from './helpers/setup.js';

const BASE = 'https://gsclaw.test';

function app(env: Env = {}): App {
  const fake = createFakeGsc();
  return createApp(testEnv(env), { name: 'test', fetch: fake.fetch, now: () => TEST_NOW });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function connect(
  target: App,
  path = '/mcp',
  mode: 'legacy' | 'auto' = 'auto',
  headers: Record<string, string> = { authorization: `Bearer ${ACCESS_TOKEN}` },
) {
  const client = new Client(
    { name: 'gsclaw-test', version: '1.0.0' },
    { versionNegotiation: { mode } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}${path}`), {
    requestInit: { headers },
    fetch: (url, init) => target.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  return client;
}

describe('HTTP app', () => {
  it('serves health and a minimal landing page without config details', async () => {
    const a = app();
    expect(await (await a.fetch(new Request(`${BASE}/healthz`))).json()).toEqual({
      status: 'ok',
      version: expect.any(String),
    });
    const page = await (await a.fetch(new Request(`${BASE}/`))).text();
    expect(page).toContain('GSClaw is running');
    expect(page).not.toMatch(/gserviceaccount|example\.com|token/i);
  });

  it('serves only a setup page when misconfigured', async () => {
    const a = createApp({}, { name: 'test' });
    expect(a.setupErrors.length).toBeGreaterThan(0);
    const res = await a.fetch(new Request(`${BASE}/`));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('GOOGLE_SERVICE_ACCOUNT_JSON');
    expect((await a.fetch(post('/mcp', {}))).status).toBe(503);
  });

  it('never shows configuration values on the public setup page', async () => {
    const secret = 'pasted-token-0123456789abcdef0123456789';
    const a = createApp(
      {
        GOOGLE_SERVICE_ACCOUNT_JSON: secret,
        GSCLAW_ACCESS_TOKEN: 'short',
        GSCLAW_MAX_ROWS: secret,
      },
      { name: 'test' },
    );
    const page = await (await a.fetch(new Request(`${BASE}/`))).text();
    expect(page).toContain('GSCLAW_MAX_ROWS');
    expect(page).not.toContain(secret);
    expect(page).not.toContain('short');
  });

  it('requires a bearer token on /mcp', async () => {
    const a = app();
    const missing = await a.fetch(post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toBe('Bearer realm="gsclaw"');
    const wrong = await a.fetch(post('/mcp', {}, { authorization: 'Bearer nope' }));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('answers wrong secret paths with 404, and can disable secret paths', async () => {
    expect((await app().fetch(post('/mcp/not-the-token', {}))).status).toBe(404);
    expect((await app().fetch(post('/mcp/a/b', {}))).status).toBe(404);
    expect((await app().fetch(post('/mcp/%E0%A4%A', {}))).status).toBe(404);
    expect(
      (await app({ GSCLAW_SECRET_PATH: 'false' }).fetch(post(`/mcp/${ACCESS_TOKEN}`, {}))).status,
    ).toBe(404);
  });

  it('rejects disallowed browser origins and allows configured ones', async () => {
    const a = app({ GSCLAW_ALLOWED_ORIGINS: 'https://allowed.example' });
    const bad = await a.fetch(
      post('/mcp', {}, { origin: 'https://evil.example', authorization: `Bearer ${ACCESS_TOKEN}` }),
    );
    expect(bad.status).toBe(403);
    const preflight = await a.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'OPTIONS',
        headers: { origin: 'https://allowed.example' },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });

  it('rate-limits per token', async () => {
    const a = app({ GSCLAW_RATE_LIMIT_PER_MINUTE: '2' });
    const ping = () =>
      a.fetch(
        post(
          '/mcp',
          { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          { authorization: `Bearer ${ACCESS_TOKEN}` },
        ),
      );
    await ping();
    await ping();
    const limited = await ping();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('enforces Host checks when bound to loopback', async () => {
    const a = createApp(testEnv(), { name: 'test', localOnly: true });
    const res = await a.fetch(
      new Request('http://attacker.example/mcp', {
        method: 'POST',
        headers: { host: 'attacker.example', authorization: `Bearer ${ACCESS_TOKEN}` },
        body: '{}',
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('MCP over HTTP', () => {
  for (const mode of ['legacy', 'auto'] as const) {
    it(`completes the handshake and lists tools (${mode} era)`, async () => {
      const client = await connect(app(), '/mcp', mode);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('striking_distance_keywords');
      expect(names).not.toContain('submit_sitemap');
      const list = tools.find((t) => t.name === 'list_sites')!;
      expect(list.annotations).toMatchObject({
        readOnlyHint: true,
        title: 'List Search Console properties',
      });
      const { prompts } = await client.listPrompts();
      expect(prompts.map((p) => p.name)).toEqual(['seo_health_check']);
      await client.close();
    });
  }

  it('works through the secret path without headers', async () => {
    const client = await connect(app(), `/mcp/${ACCESS_TOKEN}`, 'auto', {});
    const result = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('sc-domain:example.com');
    await client.close();
  });

  it('returns text plus structured content, and tool errors as isError', async () => {
    const a = app();
    const client = await connect(a);
    const ok = await client.callTool({
      name: 'keyword_cannibalization',
      arguments: { site_url: 'example.com' },
    });
    expect(ok.structuredContent).toMatchObject({ site_url: 'sc-domain:example.com' });
    const bad = await client.callTool({
      name: 'compare_periods',
      arguments: { site_url: 'not-mine.dev' },
    });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('No Search Console property matches');
    const activity = a.runtime!.activity.list();
    expect(activity.map((e) => [e.tool, e.ok])).toEqual([
      ['compare_periods', false],
      ['keyword_cannibalization', true],
    ]);
    expect(JSON.stringify(activity)).not.toContain('random name picker');
    await client.close();
  });

  it('registers write tools only when enabled', async () => {
    const client = await connect(app({ GSCLAW_ALLOW_WRITES: 'true' }));
    const { tools } = await client.listTools();
    const del = tools.find((t) => t.name === 'delete_sitemap')!;
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await client.close();
  });

  it('builds the seo_health_check prompt', async () => {
    const client = await connect(app());
    const prompt = await client.getPrompt({
      name: 'seo_health_check',
      arguments: { site_url: 'example.com', brand_terms: 'acme' },
    });
    const text = JSON.stringify(prompt.messages);
    expect(text).toContain('striking_distance_keywords');
    expect(text).toContain('exclude_queries: \\"acme\\"');
    await client.close();
  });
});
