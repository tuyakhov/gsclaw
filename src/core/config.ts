import { base64ToBytes } from './crypto.js';
import { LOG_LEVELS, type LogLevel } from './log.js';

export type Env = Record<string, string | undefined>;
export type Transport = 'http' | 'stdio';
export type AuthMode = 'service_account' | 'oauth';

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  project_id?: string;
  token_uri?: string;
}

export interface Config {
  authMode: AuthMode;
  serviceAccount?: ServiceAccountKey;
  /** Shared secret clients present in service-account mode (bearer header or secret path). */
  accessToken?: string;
  publicBaseUrl?: string;
  allowWrites: boolean;
  dashboard: boolean;
  secretPath: boolean;
  allowedOrigins: string[];
  logLevel: LogLevel;
  rateLimitPerMinute: number;
  cacheTtlSeconds: number;
  maxRows: number;
  batchInspectMax: number;
}

export interface ConfigIssue {
  variable?: string;
  message: string;
}

export type ConfigResult =
  { ok: true; config: Config; warnings: string[] } | { ok: false; errors: ConfigIssue[] };

export const MIN_ACCESS_TOKEN_LENGTH = 32;
export const SETUP_DOCS_URL = 'https://github.com/tuyakhov/gsclaw#quickstart';

/** Loads and validates configuration from environment variables. Never throws. */
export function loadConfig(env: Env, opts: { transport: Transport }): ConfigResult {
  const errors: ConfigIssue[] = [];
  const warnings: string[] = [];
  const read = (key: string) => {
    const value = env[key]?.trim();
    return value ? value : undefined;
  };

  const hasServiceAccount = Boolean(read('GOOGLE_SERVICE_ACCOUNT_JSON'));
  const hasOAuth = Boolean(read('GOOGLE_OAUTH_CLIENT_ID') || read('GOOGLE_OAUTH_CLIENT_SECRET'));
  const explicitMode = read('GSCLAW_AUTH_MODE');

  let authMode: AuthMode | undefined;
  if (explicitMode) {
    if (explicitMode === 'service_account' || explicitMode === 'oauth') authMode = explicitMode;
    else
      errors.push({
        variable: 'GSCLAW_AUTH_MODE',
        message: `must be "service_account" or "oauth" (got "${explicitMode}").`,
      });
  } else if (hasServiceAccount && hasOAuth) {
    errors.push({
      variable: 'GSCLAW_AUTH_MODE',
      message:
        'both service-account and Google OAuth variables are set. Set GSCLAW_AUTH_MODE to "service_account" or "oauth" to choose one.',
    });
  } else if (hasServiceAccount) authMode = 'service_account';
  else if (hasOAuth) authMode = 'oauth';
  else {
    errors.push({
      message:
        'No authentication mode is configured, so GSClaw refuses to start (it never runs open). ' +
        'Set GOOGLE_SERVICE_ACCOUNT_JSON' +
        (opts.transport === 'http' ? ' and GSCLAW_ACCESS_TOKEN' : '') +
        ` (service-account mode). See ${SETUP_DOCS_URL}`,
    });
  }

  let serviceAccount: ServiceAccountKey | undefined;
  let accessToken: string | undefined;

  if (authMode === 'service_account') {
    const raw = read('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!raw) {
      errors.push({
        variable: 'GOOGLE_SERVICE_ACCOUNT_JSON',
        message: 'is required in service-account mode (paste the key JSON, raw or base64).',
      });
    } else {
      const parsed = parseServiceAccountJson(raw);
      if ('error' in parsed)
        errors.push({ variable: 'GOOGLE_SERVICE_ACCOUNT_JSON', message: parsed.error });
      else serviceAccount = parsed.key;
    }

    if (opts.transport === 'http') {
      accessToken = read('GSCLAW_ACCESS_TOKEN');
      if (!accessToken) {
        errors.push({
          variable: 'GSCLAW_ACCESS_TOKEN',
          message:
            'is required for HTTP deployments so the endpoint is never public. Generate one with `openssl rand -hex 32` or `npx gsclaw generate-token`.',
        });
      } else if (accessToken.length < MIN_ACCESS_TOKEN_LENGTH) {
        errors.push({
          variable: 'GSCLAW_ACCESS_TOKEN',
          message: `must be at least ${MIN_ACCESS_TOKEN_LENGTH} characters. Generate one with \`openssl rand -hex 32\`.`,
        });
      }
    }
  }

  if (authMode === 'oauth') {
    errors.push({
      variable: 'GOOGLE_OAUTH_CLIENT_ID',
      message:
        'Google OAuth (multi-user) mode is not available in this build yet. Use service-account mode for now.',
    });
  }

  const bool = (key: string, fallback: boolean) => {
    const value = read(key);
    if (value === undefined) return fallback;
    const v = value.toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
    errors.push({ variable: key, message: `must be true or false (got "${value}").` });
    return fallback;
  };

  const int = (key: string, fallback: number, min: number, max: number) => {
    const value = read(key);
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors.push({
        variable: key,
        message: `must be an integer between ${min} and ${max} (got "${value}").`,
      });
      return fallback;
    }
    return n;
  };

  const logLevelRaw = (read('LOG_LEVEL') ?? 'info').toLowerCase();
  let logLevel: LogLevel = 'info';
  if ((LOG_LEVELS as readonly string[]).includes(logLevelRaw)) logLevel = logLevelRaw as LogLevel;
  else errors.push({ variable: 'LOG_LEVEL', message: `must be one of ${LOG_LEVELS.join(', ')}.` });

  let publicBaseUrl = read('PUBLIC_BASE_URL') ?? detectPlatformBaseUrl(env);
  if (publicBaseUrl) {
    try {
      const url = new URL(publicBaseUrl);
      publicBaseUrl = url.origin + url.pathname.replace(/\/+$/, '');
    } catch {
      errors.push({
        variable: 'PUBLIC_BASE_URL',
        message: `is not a valid URL ("${publicBaseUrl}").`,
      });
      publicBaseUrl = undefined;
    }
  }

  const allowedOrigins: string[] = [];
  for (const entry of (read('GSCLAW_ALLOWED_ORIGINS') ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      allowedOrigins.push(new URL(value).origin);
    } catch {
      errors.push({
        variable: 'GSCLAW_ALLOWED_ORIGINS',
        message: `contains an invalid origin ("${value}").`,
      });
    }
  }

  const allowWrites = bool('GSCLAW_ALLOW_WRITES', false);
  const dashboard = bool('GSCLAW_DASHBOARD', true);
  const secretPath = bool('GSCLAW_SECRET_PATH', true);
  const rateLimitPerMinute = int('GSCLAW_RATE_LIMIT_PER_MINUTE', 120, 0, 100_000);
  const cacheTtlSeconds = int('GSCLAW_CACHE_TTL_SECONDS', 300, 0, 86_400);
  const maxRows = int('GSCLAW_MAX_ROWS', 25_000, 1, 500_000);
  const batchInspectMax = int('GSCLAW_BATCH_INSPECT_MAX', 50, 1, 500);

  if (errors.length > 0 || !authMode) return { ok: false, errors };

  if (allowWrites) {
    warnings.push(
      'GSCLAW_ALLOW_WRITES=true: submit_sitemap and delete_sitemap are enabled. The service account needs Full permission on each property.',
    );
  }

  return {
    ok: true,
    warnings,
    config: {
      authMode,
      serviceAccount,
      accessToken,
      publicBaseUrl,
      allowWrites,
      dashboard,
      secretPath,
      allowedOrigins,
      logLevel,
      rateLimitPerMinute,
      cacheTtlSeconds,
      maxRows,
      batchInspectMax,
    },
  };
}

export function parseServiceAccountJson(
  raw: string,
): { key: ServiceAccountKey } | { error: string } {
  let text = raw.trim();
  if (!text.startsWith('{')) {
    try {
      text = new TextDecoder().decode(base64ToBytes(text)).trim();
    } catch {
      return { error: 'is neither JSON nor base64-encoded JSON.' };
    }
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      error:
        'is not valid JSON. Paste the whole key file you downloaded from Google Cloud (or base64-encode it).',
    };
  }
  if (!data || typeof data !== 'object') return { error: 'must be a JSON object.' };
  const obj = data as Record<string, unknown>;
  if (obj.type !== undefined && obj.type !== 'service_account') {
    return {
      error: `has type "${JSON.stringify(obj.type)}" but must be a service-account key ("type": "service_account"). OAuth client JSON files belong in GOOGLE_OAUTH_CLIENT_ID/SECRET instead.`,
    };
  }
  if (typeof obj.client_email !== 'string' || !obj.client_email.includes('@')) {
    return { error: 'is missing "client_email".' };
  }
  if (typeof obj.private_key !== 'string' || !obj.private_key.includes('PRIVATE KEY')) {
    return { error: 'is missing "private_key".' };
  }
  // Env UIs often turn real newlines into literal "\n" sequences.
  const privateKey = obj.private_key.includes('\n')
    ? obj.private_key
    : obj.private_key.replace(/\\n/g, '\n');

  return {
    key: {
      client_email: obj.client_email,
      private_key: privateKey,
      private_key_id: typeof obj.private_key_id === 'string' ? obj.private_key_id : undefined,
      project_id: typeof obj.project_id === 'string' ? obj.project_id : undefined,
      token_uri: typeof obj.token_uri === 'string' ? obj.token_uri : undefined,
    },
  };
}

/** Best-effort public URL detection so one-click deploys work without PUBLIC_BASE_URL. */
export function detectPlatformBaseUrl(env: Env): string | undefined {
  const https = (host?: string) =>
    host ? `https://${host.replace(/^https?:\/\//, '')}` : undefined;
  return (
    https(env.VERCEL_PROJECT_PRODUCTION_URL) ??
    env.URL ?? // Netlify
    env.RENDER_EXTERNAL_URL ??
    https(env.RAILWAY_PUBLIC_DOMAIN) ??
    env.APP_URL ?? // DigitalOcean App Platform
    (env.FLY_APP_NAME ? `https://${env.FLY_APP_NAME}.fly.dev` : undefined)
  );
}

export function formatConfigErrors(errors: ConfigIssue[]): string {
  const lines = errors.map((e) => `  • ${e.variable ? `${e.variable} ` : ''}${e.message}`);
  return [
    'GSClaw is not configured correctly and will not start:',
    '',
    ...lines,
    '',
    `Setup guide: ${SETUP_DOCS_URL}`,
  ].join('\n');
}
