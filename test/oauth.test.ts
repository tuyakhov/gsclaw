import {
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/core/app.js';
import type { Env } from '../src/core/config.js';
import { base64ToBytes, base64UrlEncode, sha256 } from '../src/core/crypto.js';
import { redirectUriAllowed, redirectUriMatches } from '../src/core/oauth/clients.js';
import { createSealer } from '../src/core/seal.js';
import { createFakeGsc, TEST_NOW } from './helpers/fake-gsc.js';
import {
  memoryProvider,
  REDIRECT_URI,
  sealedRequestFrom,
  withFakeGoogle,
  type GoogleUser,
} from './helpers/oauth.js';
import { ACCESS_TOKEN, testEnv } from './helpers/setup.js';

const BASE = 'https://gsclaw.test';
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

function app(env: Env = {}, fetchImpl?: typeof fetch, now: () => Date = () => TEST_NOW): App {
  return createApp(testEnv(env), { name: 'test', fetch: fetchImpl ?? createFakeGsc().fetch, now });
}

/** The browser-binding cookie set when a Google round-trip starts. */
const stateCookieFrom = (res: Response) => {
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toMatch(/^gsclaw_oauth_state=.+HttpOnly; SameSite=Lax/);
  return cookie.split(';')[0]!;
};

const call = (a: App) => (url: string | URL, init?: RequestInit) => a.fetch(new Request(url, init));

/** Runs the authorization-code flow like a real MCP client, approving on the consent page. */
async function connectWithOAuth(
  a: App,
  provider: OAuthClientProvider,
  store: { authorizationUrl?: URL },
  approve: (consentHtml: string) => Promise<Response>,
): Promise<Client> {
  const fetchFn = call(a);
  const first = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    authProvider: provider,
    fetch: fetchFn,
  });
  await expect(
    new Client(
      { name: 'oauth-test', version: '1' },
      { versionNegotiation: { mode: 'auto' } },
    ).connect(first),
  ).rejects.toThrow();
  expect(store.authorizationUrl).toBeDefined();
  const consent = await fetchFn(store.authorizationUrl!);
  expect(consent.status).toBe(200);
  const decision = await approve(await consent.text());
  expect(decision.status).toBe(302);
  const callback = new URL(decision.headers.get('location')!);
  expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
  expect(callback.searchParams.get('iss')).toBe(BASE);
  await first.finishAuth(callback.searchParams);

  const client = new Client(
    { name: 'oauth-test', version: '1' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: provider,
      fetch: fetchFn,
    }),
  );
  return client;
}

const ownerApproves = (a: App) => (html: string) =>
  a.fetch(
    new Request(`${BASE}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ request: sealedRequestFrom(html), decision: 'allow', token: ACCESS_TOKEN }),
    }),
  );

describe('sealed tokens', () => {
  it('round-trips, binds the purpose, rejects tampering, expiry and other keys', async () => {
    let now = 1_000_000;
    const sealer = createSealer('secret-a'.repeat(5), () => now);
    const token = await sealer.seal('code', { x: 1 }, 60);
    expect(token).toMatch(/^gsc_code_/);
    expect(await sealer.open('code', token)).toMatchObject({ x: 1 });
    expect(await sealer.open('access', token)).toBeNull();
    expect(await sealer.open('access', token.replace('gsc_code_', 'gsc_at_'))).toBeNull();
    // Tamper with the bytes, not the text: the last base64url character carries padding bits that
    // decoders ignore, so editing characters can leave the bytes unchanged (a ~1/256 flaky test).
    const flipBit = (sealed: string, index: (length: number) => number) => {
      const bytes = base64ToBytes(sealed.slice('gsc_code_'.length));
      bytes[index(bytes.length)]! ^= 0x01;
      return `gsc_code_${base64UrlEncode(bytes)}`;
    };
    for (let i = 0; i < 50; i++) {
      const sample = await sealer.seal('code', { x: i }, 60);
      expect(
        await sealer.open(
          'code',
          flipBit(sample, () => 12),
        ),
      ).toBeNull(); // ciphertext
      expect(
        await sealer.open(
          'code',
          flipBit(sample, (n) => n - 1),
        ),
      ).toBeNull(); // GCM tag
    }
    expect(await createSealer('secret-b'.repeat(5), () => now).open('code', token)).toBeNull();
    now += 61_000;
    expect(await sealer.open('code', token)).toBeNull();
  });
});

describe('redirect URI policy', () => {
  it('allows loopback and known clients, and extra hosts on request', () => {
    expect(redirectUriAllowed('https://claude.ai/api/mcp/auth_callback', [])).toBe(true);
    expect(redirectUriAllowed('http://127.0.0.1:5555/callback', [])).toBe(true);
    expect(redirectUriAllowed('http://evil.example/cb', [])).toBe(false);
    expect(redirectUriAllowed('https://evil.example/cb', [])).toBe(false);
    expect(redirectUriAllowed('https://evil.example/cb', ['evil.example'])).toBe(true);
    expect(redirectUriAllowed('https://claude.ai/cb#frag', [])).toBe(false);
    expect(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:9999/callback')).toBe(
      true,
    );
    expect(redirectUriMatches('https://claude.ai/a', 'https://claude.ai/b')).toBe(false);
  });
});

describe('discovery', () => {
  it('serves protected-resource and authorization-server metadata', async () => {
    const a = app();
    const prm = await (await call(a)(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
      scopes_supported: ['gsc:read'],
    });
    const asm = await (await call(a)(`${BASE}/.well-known/oauth-authorization-server`)).json();
    expect(asm).toMatchObject({
      issuer: BASE,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      registration_endpoint: `${BASE}/oauth/register`,
    });
  });

  it('points 401s at the metadata', async () => {
    const res = await call(app())(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="gsc:read"`,
    );
  });

  it('uses PUBLIC_BASE_URL when set', async () => {
    const a = app({ PUBLIC_BASE_URL: 'https://mcp.example.org' });
    const prm = (await (await call(a)(`${BASE}/.well-known/oauth-protected-resource`)).json()) as {
      resource: string;
    };
    expect(prm.resource).toBe('https://mcp.example.org/mcp');
  });
});

describe('dynamic client registration', () => {
  it('registers public clients with allowed redirect URIs only', async () => {
    const register = (a: App, body: unknown) =>
      call(a)(`${BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const ok = await register(app(), {
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toMatchObject({
      client_id: expect.stringMatching(/^gsc_client_/),
      token_endpoint_auth_method: 'none',
    });
    const bad = await register(app(), { redirect_uris: ['https://evil.example/cb'] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    const extra = await register(app({ GSCLAW_OAUTH_REDIRECT_HOSTS: 'evil.example' }), {
      redirect_uris: ['https://evil.example/cb'],
    });
    expect(extra.status).toBe(201);
  });
});

describe('owner sign-in (service-account mode)', () => {
  it('connects a real MCP client end to end: discovery → DCR → consent → token → tools', async () => {
    const a = app();
    const { provider, store } = memoryProvider({ name: 'Claude Code' });
    const client = await connectWithOAuth(a, provider, store, ownerApproves(a));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('striking_distance_keywords');
    expect((await client.callTool({ name: 'list_sites', arguments: {} })).isError).toBeFalsy();
    expect(a.runtime!.activity.list()[0]).toMatchObject({
      client: 'Claude Code',
      tool: 'list_sites',
      ok: true,
    });
    await client.close();
  });

  it('rejects a wrong access token on the consent page', async () => {
    const a = app();
    const { provider, store } = memoryProvider();
    await connectWithOAuth(a, provider, store, async (html) => {
      const wrong = await a.fetch(
        new Request(`${BASE}/oauth/authorize`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form({ request: sealedRequestFrom(html), decision: 'allow', token: 'nope' }),
        }),
      );
      expect(wrong.status).toBe(401);
      expect(await wrong.text()).toContain('not correct');
      return ownerApproves(a)(html);
    }).then((c) => c.close());
  });

  it('redirects a denial back to the client', async () => {
    const a = app();
    const { provider, store } = memoryProvider();
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      authProvider: provider,
      fetch: call(a),
    });
    await new Client({ name: 't', version: '1' }).connect(transport).catch(() => undefined);
    const html = await (await call(a)(store.authorizationUrl!)).text();
    const res = await a.fetch(
      new Request(`${BASE}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ request: sealedRequestFrom(html), decision: 'deny' }),
      }),
    );
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
});

describe('authorization and token endpoint hardening', () => {
  async function registered(a: App, redirect = REDIRECT_URI): Promise<string> {
    const res = await call(a)(`${BASE}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'T', redirect_uris: [redirect] }),
    });
    return ((await res.json()) as { client_id: string }).client_id;
  }

  async function codeFor(a: App, clientId: string, verifier = 'v'.repeat(50)) {
    const challenge = base64UrlEncode(await sha256(verifier));
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const html = await (await call(a)(`${BASE}/oauth/authorize?${q.toString()}`)).text();
    const res = await ownerApproves(a)(html);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('state')).toBe('xyz');
    return location.searchParams.get('code')!;
  }

  const token = (a: App, body: Record<string, string>) =>
    call(a)(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form(body),
    });

  it('requires PKCE and a registered redirect URI', async () => {
    const a = app();
    const clientId = await registered(a);
    const noPkce = await call(a)(
      `${BASE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT_URI }).toString()}`,
    );
    expect(new URL(noPkce.headers.get('location')!).searchParams.get('error')).toBe(
      'invalid_request',
    );
    const wrongRedirect = await call(a)(
      `${BASE}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://claude.ai/other', code_challenge: 'x', code_challenge_method: 'S256' }).toString()}`,
    );
    expect(wrongRedirect.status).toBe(400);
    expect(wrongRedirect.headers.get('location')).toBeNull();
  });

  it('checks the PKCE verifier, client and redirect URI at the token endpoint', async () => {
    const a = app();
    const clientId = await registered(a);
    const code = await codeFor(a, clientId);
    const base = {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
    };
    const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;
    expect(await errorOf(await token(a, { ...base, code_verifier: 'w'.repeat(50) }))).toBe(
      'invalid_grant',
    );
    expect(
      await errorOf(
        await token(a, { ...base, code_verifier: 'v'.repeat(50), client_id: 'someone-else' }),
      ),
    ).toBe('invalid_grant');
    const ok = await (await token(a, { ...base, code_verifier: 'v'.repeat(50) })).json();
    expect(ok).toMatchObject({
      token_type: 'Bearer',
      access_token: expect.stringMatching(/^gsc_at_/),
      refresh_token: expect.stringMatching(/^gsc_rt_/),
    });
  });

  it('rotates refresh tokens and never accepts a refresh token as an access token', async () => {
    const a = app();
    const clientId = await registered(a);
    const code = await codeFor(a, clientId);
    const first = (await (
      await token(a, {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: 'v'.repeat(50),
      })
    ).json()) as Record<string, string>;
    const refreshed = (await (
      await token(a, {
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token!,
        client_id: clientId,
      })
    ).json()) as Record<string, string>;
    expect(refreshed.access_token).toMatch(/^gsc_at_/);
    expect(refreshed.refresh_token).not.toBe(first.refresh_token);
    const misuse = await call(a)(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${first.refresh_token}` },
      body: '{}',
    });
    expect(misuse.status).toBe(401);
    expect(misuse.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('binds access tokens to this resource and expires them', async () => {
    let now = TEST_NOW.getTime();
    const fake = createFakeGsc();
    const a = createApp(testEnv(), { name: 'test', fetch: fake.fetch, now: () => new Date(now) });
    const clientId = await registered(a);
    const code = await codeFor(a, clientId);
    const { access_token } = (await (
      await token(a, {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: 'v'.repeat(50),
      })
    ).json()) as { access_token: string };
    const list = (target: App, base = BASE) =>
      target.fetch(
        new Request(`${base}/mcp`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access_token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
      );
    expect((await list(a)).status).toBe(200);
    // Same secret, different public URL: the token's audience no longer matches.
    expect((await list(a, 'https://other.example')).status).toBe(401);
    now += 3601_000;
    expect((await list(a)).status).toBe(401);
  });
});

describe('client ID metadata documents (CIMD)', () => {
  it('fetches and validates the document at the client_id URL', async () => {
    const metadataUrl = 'https://client.example.com/oauth/metadata.json';
    const inner = createFakeGsc().fetch;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === metadataUrl) {
        return Response.json({
          client_id: metadataUrl,
          client_name: 'Metadata Client',
          redirect_uris: [REDIRECT_URI],
        });
      }
      return inner(input, init);
    }) as typeof fetch;
    const a = app({}, fetchImpl);
    const { provider, store } = memoryProvider({ clientMetadataUrl: metadataUrl });
    const client = await connectWithOAuth(a, provider, store, async (html) => {
      expect(html).toContain('Metadata Client');
      return ownerApproves(a)(html);
    });
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    await client.close();
  });
});

describe('Google OAuth mode (multi-user)', () => {
  const CLIENT_ID = 'test-client.apps.googleusercontent.com';
  const oauthEnv: Env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
    GSCLAW_ACCESS_TOKEN: undefined,
    GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: 'test-secret',
    GSCLAW_ENCRYPTION_KEY: 'k'.repeat(48),
    PUBLIC_BASE_URL: BASE,
    ALLOWED_GOOGLE_DOMAINS: 'example.com',
  };
  const users: GoogleUser[] = [
    { sub: 'alice', email: 'alice@example.com' },
    { sub: 'mallory', email: 'mallory@elsewhere.dev' },
    { sub: 'noscope', email: 'noscope@example.com', scopes: [] },
  ];

  function oauthApp(env: Env = {}) {
    const fake = createFakeGsc();
    const google = withFakeGoogle(fake.fetch, users, CLIENT_ID, () =>
      Math.floor(TEST_NOW.getTime() / 1000),
    );
    const a = createApp(
      { ...testEnv(oauthEnv), ...env },
      { name: 'test', fetch: google.fetch, now: () => TEST_NOW },
    );
    expect(a.setupErrors).toEqual([]);
    return { a, fake, google };
  }

  /** Clicks "Continue with Google", then simulates Google redirecting back for `sub`. */
  const viaGoogle = (a: App, sub: string) => async (html: string) => {
    const toGoogle = await a.fetch(
      new Request(`${BASE}/oauth/authorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ request: sealedRequestFrom(html), decision: 'allow' }),
      }),
    );
    const googleUrl = new URL(toGoogle.headers.get('location')!);
    expect(googleUrl.origin).toBe('https://accounts.google.com');
    expect(googleUrl.searchParams.get('scope')).toContain('webmasters.readonly');
    expect(googleUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(googleUrl.searchParams.get('redirect_uri')).toBe(`${BASE}/oauth/google/callback`);
    const state = googleUrl.searchParams.get('state')!;
    return a.fetch(
      new Request(
        `${BASE}/oauth/google/callback?${new URLSearchParams({ code: `code-${sub}`, state }).toString()}`,
        { headers: { cookie: stateCookieFrom(toGoogle) } },
      ),
    );
  };

  it('refuses to start without the required settings', () => {
    const a = createApp({ GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID }, { name: 'test' });
    expect(a.setupErrors.map((e) => e.variable).sort()).toEqual([
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GSCLAW_ENCRYPTION_KEY',
      'PUBLIC_BASE_URL',
    ]);
  });

  it('signs a user in through Google and serves their own Search Console data', async () => {
    const { a, fake, google } = oauthApp();
    const { provider, store } = memoryProvider({ name: 'Claude' });
    const client = await connectWithOAuth(a, provider, store, viaGoogle(a, 'alice'));
    expect(google.exchanges[0]).toMatchObject({
      grant_type: 'authorization_code',
      code: 'code-alice',
      client_secret: 'test-secret',
    });
    expect(google.exchanges[0]!.code_verifier).toBeTruthy();
    const result = await client.callTool({ name: 'list_sites', arguments: {} });
    expect(result.isError).toBeFalsy();
    // The user's own Google token reached Search Console (never the GSClaw token, never a service account).
    expect(fake.calls.filter((c) => c.url.includes('/webmasters/v3/sites')).at(-1)!.auth).toBe(
      'Bearer ya29.alice-1',
    );
    expect(a.runtime!.activity.list()[0]).toMatchObject({
      user: 'alice@example.com',
      client: 'Claude',
    });
    await client.close();
  });

  it('enforces the allowlist', async () => {
    const { a } = oauthApp();
    const { provider, store } = memoryProvider();
    await new Client({ name: 't', version: '1' })
      .connect(
        new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
          authProvider: provider,
          fetch: call(a),
        }),
      )
      .catch(() => undefined);
    const html = await (await call(a)(store.authorizationUrl!)).text();
    const back = await viaGoogle(a, 'mallory')(html);
    const location = new URL(back.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toContain('not allowed');
  });

  it('requires the Search Console scope to be granted', async () => {
    const { a } = oauthApp();
    const { provider, store } = memoryProvider();
    await new Client({ name: 't', version: '1' })
      .connect(
        new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
          authProvider: provider,
          fetch: call(a),
        }),
      )
      .catch(() => undefined);
    const html = await (await call(a)(store.authorizationUrl!)).text();
    const back = await viaGoogle(a, 'noscope')(html);
    expect(new URL(back.headers.get('location')!).searchParams.get('error_description')).toContain(
      'Search Console access was not granted',
    );
  });

  it('signs in to the dashboard with Google', async () => {
    const { a } = oauthApp();
    const start = await call(a)(`${BASE}/oauth/google/start`);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = `${BASE}/oauth/google/callback?${new URLSearchParams({ code: 'code-alice', state }).toString()}`;
    // Login CSRF: a callback URL replayed in another browser (without the state cookie) is refused.
    const elsewhere = await call(a)(callback);
    expect(elsewhere.status).toBe(400);
    expect(elsewhere.headers.get('set-cookie')).toBeNull();
    const forged = await call(a)(callback, {
      headers: { cookie: 'gsclaw_oauth_state=not-the-right-value' },
    });
    expect(forged.status).toBe(400);
    const back = await call(a)(callback, { headers: { cookie: stateCookieFrom(start) } });
    expect(back.headers.get('location')).toBe('/');
    const cookie = back.headers.get('set-cookie')!.split(';')[0]!;
    const session = await (await call(a)(`${BASE}/api/session`, { headers: { cookie } })).json();
    expect(session).toMatchObject({
      authenticated: true,
      login: 'google',
      email: 'alice@example.com',
    });
    expect((await call(a)(`${BASE}/api/connect/secret`, { headers: { cookie } })).status).toBe(404);
    const sites = (await (
      await call(a)(`${BASE}/api/tools/list_sites`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      })
    ).json()) as { result: { identity: string } };
    expect(sites.result.identity).toBe('alice@example.com');
  });

  it('applies allowlist changes to existing tokens and sessions', async () => {
    const { a } = oauthApp();
    const { provider, store } = memoryProvider();
    const client = await connectWithOAuth(a, provider, store, viaGoogle(a, 'alice'));
    await client.close();
    const tokens = store.tokens as { access_token: string; refresh_token: string };
    const start = await call(a)(`${BASE}/oauth/google/start`);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const back = await call(a)(
      `${BASE}/oauth/google/callback?${new URLSearchParams({ code: 'code-alice', state }).toString()}`,
      { headers: { cookie: stateCookieFrom(start) } },
    );
    const cookie = back.headers.get('set-cookie')!.split(';')[0]!;

    // Same encryption key, but alice's domain is no longer allowed.
    const { a: narrowed } = oauthApp({ ALLOWED_GOOGLE_DOMAINS: 'other.example' });
    const mcp = await call(narrowed)(`${BASE}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.access_token}` },
      body: '{}',
    });
    expect(mcp.status).toBe(401);
    const refresh = await call(narrowed)(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    });
    expect(((await refresh.json()) as { error: string }).error).toBe('invalid_grant');
    const session = (await (
      await call(narrowed)(`${BASE}/api/session`, { headers: { cookie } })
    ).json()) as { authenticated: boolean };
    expect(session.authenticated).toBe(false);
  });

  it('never lets an unverified email satisfy an allowlist added later', async () => {
    const fake = createFakeGsc();
    const unverified: GoogleUser = { sub: 'eve', email: 'eve@example.com', emailVerified: false };
    const google = withFakeGoogle(fake.fetch, [unverified], CLIENT_ID, () =>
      Math.floor(TEST_NOW.getTime() / 1000),
    );
    const env = { ...testEnv(oauthEnv), ALLOWED_GOOGLE_DOMAINS: undefined };
    const open = createApp(env, { name: 'test', fetch: google.fetch, now: () => TEST_NOW });
    const start = await call(open)(`${BASE}/oauth/google/start`);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const back = await call(open)(
      `${BASE}/oauth/google/callback?${new URLSearchParams({ code: 'code-eve', state }).toString()}`,
      { headers: { cookie: stateCookieFrom(start) } },
    );
    const cookie = back.headers.get('set-cookie')!.split(';')[0]!;
    const sessionIn = async (target: App) =>
      (
        (await (await call(target)(`${BASE}/api/session`, { headers: { cookie } })).json()) as {
          authenticated: boolean;
        }
      ).authenticated;
    expect(await sessionIn(open)).toBe(true);
    const restricted = createApp(
      { ...env, ALLOWED_GOOGLE_DOMAINS: 'example.com' },
      { name: 'test', fetch: google.fetch, now: () => TEST_NOW },
    );
    expect(await sessionIn(restricted)).toBe(false);
  });

  it('has no static token or secret path', async () => {
    const { a } = oauthApp();
    expect(
      (await call(a)(`${BASE}/mcp/${ACCESS_TOKEN}`, { method: 'POST', body: '{}' })).status,
    ).toBe(404);
    expect(
      (
        await call(a)(`${BASE}/mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });
});

describe('revocation', () => {
  it('rotating the access token revokes owner OAuth tokens and sessions', async () => {
    const env = { GSCLAW_ENCRYPTION_KEY: 'e'.repeat(40) };
    const a = app(env);
    const login = await call(a)(`${BASE}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ACCESS_TOKEN }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const session = (target: App) =>
      call(target)(`${BASE}/api/session`, { headers: { cookie } }).then(
        async (r) => ((await r.json()) as { authenticated: boolean }).authenticated,
      );
    expect(await session(a)).toBe(true);
    expect(await session(app(env))).toBe(true);
    const rotated = app({
      ...env,
      GSCLAW_ACCESS_TOKEN: 'rotated-token-0123456789abcdef0123456789',
    });
    expect(await session(rotated)).toBe(false);
  });
});
