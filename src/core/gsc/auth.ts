import type { ServiceAccountKey } from '../config.js';
import { base64ToBytes, base64UrlEncode, utf8 } from '../crypto.js';
import { GscApiError, type Identity } from '../errors.js';

export const SCOPE_READONLY = 'https://www.googleapis.com/auth/webmasters.readonly';
export const SCOPE_READWRITE = 'https://www.googleapis.com/auth/webmasters';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Supplies Google access tokens for one identity (a service account or a signed-in user). */
export interface TokenSource {
  readonly identity: Identity;
  readonly scopes: string[];
  getAccessToken(): Promise<string>;
  /** Drops any cached token, e.g. after Google answered 401. */
  invalidate(): void;
}

const EXPIRY_MARGIN_MS = 60_000;

/** WebCrypto key type without depending on DOM or node:crypto typings. */
type SigningKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * Service-account tokens via the OAuth 2.0 JWT bearer flow, signed with WebCrypto (RS256) so it
 * runs on Node and Cloudflare Workers alike. The imported key and the access token are cached for
 * the life of the instance.
 */
export class ServiceAccountTokenSource implements TokenSource {
  readonly identity: Identity;
  readonly scopes: string[];
  private readonly key: ServiceAccountKey;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cryptoKey?: Promise<SigningKey>;
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(
    key: ServiceAccountKey,
    scopes: string[],
    opts: { fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.key = key;
    this.scopes = scopes;
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.identity = { kind: 'service_account', email: key.client_email, projectId: key.project_id };
  }

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - EXPIRY_MARGIN_MS > this.now())
      return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  /** Builds the signed JWT assertion. Exposed for tests. */
  async createAssertion(): Promise<string> {
    const iat = Math.floor(this.now() / 1000);
    const header = {
      alg: 'RS256',
      typ: 'JWT',
      ...(this.key.private_key_id ? { kid: this.key.private_key_id } : {}),
    };
    const claims = {
      iss: this.key.client_email,
      scope: this.scopes.join(' '),
      aud: this.key.token_uri ?? GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
    };
    const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
    this.cryptoKey ??= importPkcs8(this.key.private_key);
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      await this.cryptoKey,
      utf8(signingInput),
    );
    return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
  }

  private async fetchToken(): Promise<string> {
    let assertion: string;
    try {
      assertion = await this.createAssertion();
    } catch {
      this.cryptoKey = undefined;
      throw new GscApiError({
        kind: 'auth',
        status: 0,
        googleMessage: '',
        advice:
          'The service-account private key could not be read. Make sure GOOGLE_SERVICE_ACCOUNT_JSON contains the complete key file, including "-----BEGIN PRIVATE KEY-----".',
      });
    }

    const res = await this.fetchImpl(this.key.token_uri ?? GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      const detail = [body.error, body.error_description].filter(Boolean).join(': ');
      throw new GscApiError({
        kind: 'auth',
        status: res.status,
        reason: body.error,
        googleMessage: detail,
        retryable: res.status >= 500,
        advice:
          body.error === 'invalid_grant'
            ? 'Google refused the service-account token (invalid_grant). Usually the key was deleted in Google Cloud, or this server’s clock is off by more than a few minutes. Create a new key and update GOOGLE_SERVICE_ACCOUNT_JSON.'
            : `Could not obtain a Google access token for the service account ${this.key.client_email}. Check that the key is valid and not disabled.`,
      });
    }
    this.cached = {
      token: body.access_token,
      expiresAt: this.now() + (body.expires_in ?? 3600) * 1000,
    };
    return body.access_token;
  }
}

async function importPkcs8(pem: string): Promise<SigningKey> {
  const der = base64ToBytes(
    pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, ''),
  );
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}
