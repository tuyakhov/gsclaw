import { createPublicKey, createVerify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createResponseCache, GscClient } from '../src/core/gsc/client.js';
import { SCOPE_READONLY, ServiceAccountTokenSource } from '../src/core/gsc/auth.js';
import { resolveProperty } from '../src/core/gsc/sites.js';
import { GscApiError, toGscApiError } from '../src/core/errors.js';
import { parseServiceAccountJson } from '../src/core/config.js';
import { createFakeGsc, SITE } from './helpers/fake-gsc.js';
import { quietLogger, serviceAccountJson, testKeyPair } from './helpers/setup.js';

function key() {
  const parsed = parseServiceAccountJson(serviceAccountJson());
  if (!('key' in parsed)) throw new Error('bad key');
  return parsed.key;
}

function client(fake = createFakeGsc(), opts: { cache?: boolean } = {}) {
  const tokenSource = new ServiceAccountTokenSource(key(), [SCOPE_READONLY], { fetch: fake.fetch });
  return {
    fake,
    gsc: new GscClient({
      tokenSource,
      logger: quietLogger,
      fetch: fake.fetch,
      cache: opts.cache ? createResponseCache() : undefined,
      sleep: () => Promise.resolve(),
    }),
  };
}

describe('ServiceAccountTokenSource', () => {
  it('signs an RS256 JWT assertion Google can verify', async () => {
    const source = new ServiceAccountTokenSource(key(), [SCOPE_READONLY], {
      now: () => 1_800_000_000_000,
    });
    const jwt = await source.createAssertion();
    const [header, claims, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: 'key-1',
    });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      iss: 'gsclaw@gsclaw-test.iam.gserviceaccount.com',
      scope: SCOPE_READONLY,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    });
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${claims}`);
    expect(
      verify.verify(createPublicKey(testKeyPair().publicPem), Buffer.from(signature!, 'base64url')),
    ).toBe(true);
  });

  it('caches the access token and dedupes concurrent requests', async () => {
    const fake = createFakeGsc();
    const source = new ServiceAccountTokenSource(key(), [SCOPE_READONLY], { fetch: fake.fetch });
    const tokens = await Promise.all([
      source.getAccessToken(),
      source.getAccessToken(),
      source.getAccessToken(),
    ]);
    expect(new Set(tokens)).toEqual(new Set(['ya29.test-token']));
    expect(fake.calls.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });

  it('explains invalid_grant', async () => {
    const fake = createFakeGsc();
    fake.failNext('oauth2.googleapis.com', 400, {
      error: 'invalid_grant',
      error_description: 'Invalid JWT Signature.',
    });
    const source = new ServiceAccountTokenSource(key(), [SCOPE_READONLY], { fetch: fake.fetch });
    await expect(source.getAccessToken()).rejects.toThrow(/key was deleted|clock/);
  });
});

describe('GscClient', () => {
  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const { gsc, fake } = client();
    fake.failNext('/sites', 429, {
      error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' },
    });
    fake.failNext('/sites', 503, { error: { code: 503, message: 'Backend Error' } });
    const sites = await gsc.listSites();
    expect(sites.length).toBe(4);
    expect(fake.calls.filter((c) => c.url.endsWith('/sites')).length).toBe(3);
  });

  it('gives up after the retry budget', async () => {
    const { gsc, fake } = client();
    fake.failNext('/sites', 503, { error: { code: 503, message: 'Backend Error' } }, 10);
    await expect(gsc.listSites()).rejects.toBeInstanceOf(GscApiError);
    expect(fake.calls.filter((c) => c.url.endsWith('/sites')).length).toBe(4);
  });

  it('refreshes the token once on 401', async () => {
    const { gsc, fake } = client();
    fake.failNext('/sites', 401, {
      error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' },
    });
    await gsc.listSites();
    expect(fake.calls.filter((c) => c.url.includes('oauth2')).length).toBe(2);
  });

  it('maps a permission error to actionable advice naming the service account', async () => {
    const { gsc } = client();
    const error = await gsc
      .searchAnalytics('sc-domain:not-mine.com', { startDate: '2026-09-01', endDate: '2026-09-30' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GscApiError);
    const message = (error as GscApiError).message;
    expect(message).toContain('gsclaw@gsclaw-test.iam.gserviceaccount.com');
    expect(message).toMatch(/Settings → Users and permissions/);
    expect(message).toContain('sc-domain:not-mine.com');
  });

  it('paginates through startRow', async () => {
    const { gsc, fake } = client();
    const spy = vi.spyOn(gsc, 'searchAnalytics');
    const { rows, truncated } = await gsc.searchAnalyticsAll(
      SITE,
      { startDate: '2026-09-01', endDate: '2026-09-30', dimensions: ['query', 'date'] },
      150,
    );
    expect(rows.length).toBe(150);
    expect(truncated).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(fake.calls.at(-1)!.body).toMatchObject({ rowLimit: 150, startRow: 0 });
  });

  it('caches identical reads per identity', async () => {
    const { gsc, fake } = client(createFakeGsc(), { cache: true });
    await gsc.listSites();
    await gsc.listSites();
    expect(fake.calls.filter((c) => c.url.endsWith('/sites')).length).toBe(1);
  });
});

describe('toGscApiError', () => {
  const identity = {
    kind: 'service_account' as const,
    email: 'sa@p.iam.gserviceaccount.com',
    projectId: 'my-proj',
  };

  it('detects a disabled API', () => {
    const error = toGscApiError(
      403,
      {
        error: {
          code: 403,
          message:
            'Google Search Console API has not been used in project 123 before or it is disabled.',
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      },
      { identity },
    );
    expect(error.kind).toBe('api_disabled');
    expect(error.message).toContain(
      'console.cloud.google.com/apis/library/searchconsole.googleapis.com?project=my-proj',
    );
  });

  it('detects daily quota exhaustion', () => {
    const error = toGscApiError(
      403,
      { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } },
      { identity },
    );
    expect(error.kind).toBe('quota_exceeded');
  });
});

describe('resolveProperty', () => {
  it('matches exact, bare-domain and URL inputs', async () => {
    const { gsc } = client();
    expect((await resolveProperty(gsc, 'sc-domain:example.com')).site_url).toBe(
      'sc-domain:example.com',
    );
    expect((await resolveProperty(gsc, 'example.com')).site_url).toBe('sc-domain:example.com');
    expect((await resolveProperty(gsc, 'https://www.example.com/blog/post')).site_url).toBe(
      'https://www.example.com/',
    );
    expect((await resolveProperty(gsc, 'https://shop.example.com/x')).site_url).toBe(
      'sc-domain:example.com',
    );
    expect((await resolveProperty(gsc, 'blog.example.org')).site_url).toBe(
      'https://blog.example.org/',
    );
  });

  it('lists available properties when nothing matches', async () => {
    const { gsc } = client();
    await expect(resolveProperty(gsc, 'nope.dev')).rejects.toThrow(
      /Available properties: 'sc-domain:example.com'/,
    );
  });

  it('refuses unverified properties', async () => {
    const { gsc } = client();
    await expect(resolveProperty(gsc, 'http://legacy.example.net/')).rejects.toThrow(/unverified/);
  });
});
