import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createStaticHandler } from '../src/adapters/static.js';
import { createApp, type App } from '../src/core/app.js';
import type { Env } from '../src/core/config.js';
import { signSession, verifySession } from '../src/core/session.js';
import { isNewer, latestRelease, resetUpdateCheckCache } from '../src/core/update-check.js';
import { createFakeGsc, TEST_NOW } from './helpers/fake-gsc.js';
import { ACCESS_TOKEN, testEnv } from './helpers/setup.js';

const BASE = 'https://gsclaw.test';

function app(env: Env = {}): App {
  return createApp(testEnv(env), {
    name: 'test',
    fetch: createFakeGsc().fetch,
    now: () => TEST_NOW,
  });
}

function req(path: string, init: RequestInit & { cookie?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.body) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { ...init, headers });
}

async function signIn(a: App): Promise<string> {
  const res = await a.fetch(
    req('/api/session', { method: 'POST', body: JSON.stringify({ token: ACCESS_TOKEN }) }),
  );
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

describe('dashboard shell', () => {
  it('serves the app shell at / with a strict CSP and no data', async () => {
    const res = await app().fetch(req('/'));
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    const html = await res.text();
    expect(html).toContain('/assets/dashboard.js');
    expect(html).not.toMatch(/gserviceaccount|example\.com/);
  });

  it('can be switched off', async () => {
    const a = app({ GSCLAW_DASHBOARD: 'false' });
    expect(await (await a.fetch(req('/'))).text()).toContain('GSClaw is running');
    expect((await a.fetch(req('/api/session'))).status).toBe(404);
  });
});

describe('dashboard sessions', () => {
  it('rejects a wrong token and issues a hardened cookie for the right one', async () => {
    const a = app();
    const wrong = await a.fetch(
      req('/api/session', { method: 'POST', body: JSON.stringify({ token: 'nope' }) }),
    );
    expect(wrong.status).toBe(401);
    const ok = await a.fetch(
      req('/api/session', { method: 'POST', body: JSON.stringify({ token: ACCESS_TOKEN }) }),
    );
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^gsclaw_session=v1\./);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=604800'])
      expect(cookie).toContain(attr);
    expect(cookie).not.toContain(ACCESS_TOKEN);
  });

  it('omits Secure only for plain-http loopback development', async () => {
    const a = app();
    const res = await a.fetch(
      new Request('http://localhost:3000/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: ACCESS_TOKEN }),
      }),
    );
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('requires a valid session for data endpoints', async () => {
    const a = app();
    expect((await a.fetch(req('/api/status'))).status).toBe(401);
    expect(
      (await a.fetch(req('/api/status', { cookie: 'gsclaw_session=v1.e30.forged' }))).status,
    ).toBe(401);
    const cookie = await signIn(a);
    expect((await a.fetch(req('/api/status', { cookie }))).status).toBe(200);
    const signedOut = await a.fetch(req('/api/session', { method: 'DELETE', cookie }));
    expect(signedOut.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('rejects cross-origin state changes', async () => {
    const res = await app().fetch(
      req('/api/session', {
        method: 'POST',
        body: JSON.stringify({ token: ACCESS_TOKEN }),
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rate-limits login attempts', async () => {
    const a = app();
    const attempt = () =>
      a.fetch(req('/api/session', { method: 'POST', body: JSON.stringify({ token: 'x' }) }));
    for (let i = 0; i < 10; i++) await attempt();
    expect((await attempt()).status).toBe(429);
  });

  it('signs and verifies session tokens', async () => {
    const value = await signSession({ sub: 'owner', exp: 2_000 }, 'secret-a');
    expect(await verifySession(value, 'secret-a', 1_000)).toEqual({ sub: 'owner', exp: 2_000 });
    expect(await verifySession(value, 'secret-a', 2_001)).toBeNull(); // expired
    expect(await verifySession(value, 'secret-b', 1_000)).toBeNull(); // rotated secret
    const [v, , sig] = value.split('.');
    const forged = `${v}.${Buffer.from(JSON.stringify({ sub: 'owner', exp: 9e9 })).toString('base64url')}.${sig}`;
    expect(await verifySession(forged, 'secret-a', 1_000)).toBeNull();
  });
});

describe('dashboard API', () => {
  it('reports status without leaking the access token', async () => {
    const a = app();
    const cookie = await signIn(a);
    const res = await a.fetch(req('/api/status', { cookie }));
    const text = await res.text();
    expect(text).not.toContain(ACCESS_TOKEN);
    const status = JSON.parse(text);
    expect(status).toMatchObject({
      auth_mode: 'service_account',
      identity: { email: 'gsclaw@gsclaw-test.iam.gserviceaccount.com' },
      writes_enabled: false,
      latest_version: null,
      google: { ok: true },
    });
    expect(status.google.properties).toHaveLength(4);
  });

  it('reveals the token only to a signed-in session', async () => {
    const a = app();
    expect((await a.fetch(req('/api/connect/secret'))).status).toBe(401);
    const cookie = await signIn(a);
    expect(await (await a.fetch(req('/api/connect/secret', { cookie }))).json()).toEqual({
      access_token: ACCESS_TOKEN,
    });
  });

  it('returns the same numbers as the MCP tool (parity)', async () => {
    const a = app();
    const cookie = await signIn(a);
    const input = { site_url: 'example.com', dimension: 'query', view: 'all', limit: 5 };
    const viaDashboard = (await (
      await a.fetch(
        req('/api/tools/compare_periods', { method: 'POST', body: JSON.stringify(input), cookie }),
      )
    ).json()) as { result: { totals: { current: { clicks: number } } } };

    const client = new Client(
      { name: 'parity', version: '1' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${ACCESS_TOKEN}` } },
        fetch: (url, init) => a.fetch(new Request(url, init)),
      }),
    );
    const viaMcp = await client.callTool({ name: 'compare_periods', arguments: input });
    await client.close();

    expect(viaDashboard.result).toEqual(viaMcp.structuredContent);
    expect(viaDashboard.result.totals.current.clicks).toBeGreaterThan(0);
  });

  it('validates tool input and never exposes write tools', async () => {
    const a = app({ GSCLAW_ALLOW_WRITES: 'true' });
    const cookie = await signIn(a);
    const bad = await a.fetch(
      req('/api/tools/compare_periods', {
        method: 'POST',
        body: JSON.stringify({ date_range: 'yesterday' }),
        cookie,
      }),
    );
    expect(bad.status).toBe(400);
    const write = await a.fetch(
      req('/api/tools/submit_sitemap', {
        method: 'POST',
        body: JSON.stringify({ site_url: 'example.com', sitemap_url: 'https://example.com/s.xml' }),
        cookie,
      }),
    );
    expect(write.status).toBe(404);
  });

  it('does not record dashboard calls in the MCP activity log', async () => {
    const a = app();
    const cookie = await signIn(a);
    await a.fetch(req('/api/tools/list_sites', { method: 'POST', body: '{}', cookie }));
    const activity = await (await a.fetch(req('/api/activity', { cookie }))).json();
    expect(activity).toEqual({ persistent: false, entries: [] });
  });
});

describe('update check', () => {
  it('compares versions', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true);
    expect(isNewer('v1.2.0', '1.2.0')).toBe(false);
    expect(isNewer('0.10.0', '0.9.3')).toBe(true);
  });

  it('reads the latest release and fails silently', async () => {
    resetUpdateCheckCache();
    const ok = (async () => Response.json({ tag_name: 'v9.9.9' })) as typeof fetch;
    expect(await latestRelease(ok, 0)).toBe('9.9.9');
    resetUpdateCheckCache();
    const broken = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    expect(await latestRelease(broken, 0)).toBeNull();
    resetUpdateCheckCache();
  });
});

describe('static file handler (Node)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gsclaw-static-'));
  writeFileSync(join(dir, 'app.js'), 'console.log(1)');
  const serve = createStaticHandler(dir);

  it('serves files with content type and ETag', async () => {
    const res = (await serve(new Request('http://x/app.js')))!;
    expect(res.headers.get('content-type')).toContain('javascript');
    const again = (await serve(
      new Request('http://x/app.js', { headers: { 'if-none-match': res.headers.get('etag')! } }),
    ))!;
    expect(again.status).toBe(304);
  });

  it('refuses path traversal and missing files', async () => {
    expect(await serve(new Request('http://x/%2e%2e/%2e%2e/etc/passwd'))).toBeNull();
    expect(await serve(new Request('http://x/missing.js'))).toBeNull();
  });
});
