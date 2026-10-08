import { createLogger } from '../../src/core/log.js';
import { loadConfig, type Config, type Env } from '../../src/core/config.js';
import { createRuntime, type Runtime } from '../../src/core/runtime.js';
import { createFakeGsc, TEST_NOW, type FakeGsc } from './fake-gsc.js';
import { generateKeyPairSync } from 'node:crypto';

export const ACCESS_TOKEN = 'test-access-token-0123456789abcdef0123456789';

let cachedKey: { privatePem: string; publicPem: string } | undefined;

export function testKeyPair() {
  cachedKey ??= (() => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return { privatePem: privateKey, publicPem: publicKey };
  })();
  return cachedKey;
}

export function serviceAccountJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'gsclaw-test',
    private_key_id: 'key-1',
    private_key: testKeyPair().privatePem,
    client_email: 'gsclaw@gsclaw-test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

export function testEnv(overrides: Env = {}): Env {
  return {
    GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson(),
    GSCLAW_ACCESS_TOKEN: ACCESS_TOKEN,
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

export function testConfig(overrides: Env = {}): Config {
  const result = loadConfig(testEnv(overrides), { transport: 'http' });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.config;
}

/** Service-account runtime plus the owner's session (gsc, ctx, tools) and the fake backend. */
export function testRuntime(opts: { env?: Env; fake?: FakeGsc } = {}) {
  const fake = opts.fake ?? createFakeGsc();
  const runtime: Runtime = createRuntime(testConfig(opts.env), {
    fetch: fake.fetch,
    now: () => TEST_NOW,
  });
  return { ...runtime, ...runtime.owner!, fake };
}

export const quietLogger = createLogger({ level: 'silent' });
