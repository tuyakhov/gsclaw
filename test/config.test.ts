import { describe, expect, it } from 'vitest';
import {
  detectPlatformBaseUrl,
  formatConfigErrors,
  loadConfig,
  parseServiceAccountJson,
} from '../src/core/config.js';
import { bytesToBase64, utf8 } from '../src/core/crypto.js';
import { ACCESS_TOKEN, serviceAccountJson, testEnv } from './helpers/setup.js';

describe('loadConfig', () => {
  it('refuses to start with no auth mode configured', () => {
    const result = loadConfig({}, { transport: 'http' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(formatConfigErrors(result.errors)).toMatch(/refuses to start/);
    expect(formatConfigErrors(result.errors)).toMatch(
      /GOOGLE_SERVICE_ACCOUNT_JSON and GSCLAW_ACCESS_TOKEN/,
    );
  });

  it('requires an access token over HTTP but not over stdio', () => {
    const env = { GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson() };
    const http = loadConfig(env, { transport: 'http' });
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.errors.map((e) => e.variable)).toContain('GSCLAW_ACCESS_TOKEN');
    expect(loadConfig(env, { transport: 'stdio' }).ok).toBe(true);
  });

  it('rejects short access tokens', () => {
    const result = loadConfig(testEnv({ GSCLAW_ACCESS_TOKEN: 'short' }), { transport: 'http' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.message).toMatch(/at least 32/);
  });

  it('applies defaults', () => {
    const result = loadConfig(testEnv({ LOG_LEVEL: undefined }), { transport: 'http' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toMatchObject({
      authMode: 'service_account',
      accessToken: ACCESS_TOKEN,
      allowWrites: false,
      dashboard: true,
      secretPath: true,
      logLevel: 'info',
      rateLimitPerMinute: 120,
      maxRows: 25_000,
    });
  });

  it('validates booleans, integers and origins', () => {
    const result = loadConfig(
      testEnv({
        GSCLAW_ALLOW_WRITES: 'maybe',
        GSCLAW_MAX_ROWS: '-5',
        GSCLAW_ALLOWED_ORIGINS: 'not a url',
      }),
      { transport: 'http' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.variable).sort()).toEqual([
      'GSCLAW_ALLOWED_ORIGINS',
      'GSCLAW_ALLOW_WRITES',
      'GSCLAW_MAX_ROWS',
    ]);
  });

  it('warns when writes are enabled', () => {
    const result = loadConfig(testEnv({ GSCLAW_ALLOW_WRITES: 'true' }), { transport: 'http' });
    expect(result.ok && result.warnings[0]).toMatch(/submit_sitemap/);
  });

  it('requires choosing a mode when both are configured', () => {
    const result = loadConfig(testEnv({ GOOGLE_OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com' }), {
      transport: 'http',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.variable).toBe('GSCLAW_AUTH_MODE');
  });

  it('never echoes secret values in error messages', () => {
    const secret = 'super-secret-value';
    const result = loadConfig(
      { GOOGLE_SERVICE_ACCOUNT_JSON: `{"private_key":"${secret}"}`, GSCLAW_ACCESS_TOKEN: secret },
      { transport: 'http' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(formatConfigErrors(result.errors)).not.toContain(secret);
  });
});

describe('parseServiceAccountJson', () => {
  it('accepts raw JSON', () => {
    const parsed = parseServiceAccountJson(serviceAccountJson());
    expect('key' in parsed && parsed.key.client_email).toBe(
      'gsclaw@gsclaw-test.iam.gserviceaccount.com',
    );
  });

  it('accepts base64-encoded JSON', () => {
    const parsed = parseServiceAccountJson(bytesToBase64(utf8(serviceAccountJson())));
    expect('key' in parsed && parsed.key.project_id).toBe('gsclaw-test');
  });

  it('repairs literal \\n sequences in the private key', () => {
    const json = JSON.parse(serviceAccountJson()) as { private_key: string };
    const escaped = serviceAccountJson({ private_key: json.private_key.replace(/\n/g, '\\n') });
    const parsed = parseServiceAccountJson(escaped);
    expect('key' in parsed && parsed.key.private_key).toContain('\n');
  });

  it('explains common mistakes', () => {
    expect(parseServiceAccountJson('{"type":"authorized_user"}')).toMatchObject({
      error: expect.stringMatching(/service-account key/),
    });
    expect(parseServiceAccountJson('{"type":"service_account"}')).toMatchObject({
      error: expect.stringMatching(/client_email/),
    });
    expect(parseServiceAccountJson('{not json')).toMatchObject({
      error: expect.stringMatching(/not valid JSON/),
    });
  });
});

describe('detectPlatformBaseUrl', () => {
  it('detects common platforms', () => {
    expect(detectPlatformBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: 'gsclaw.vercel.app' })).toBe(
      'https://gsclaw.vercel.app',
    );
    expect(detectPlatformBaseUrl({ RENDER_EXTERNAL_URL: 'https://gsclaw.onrender.com' })).toBe(
      'https://gsclaw.onrender.com',
    );
    expect(detectPlatformBaseUrl({ FLY_APP_NAME: 'gsclaw' })).toBe('https://gsclaw.fly.dev');
    expect(detectPlatformBaseUrl({})).toBeUndefined();
  });
});
