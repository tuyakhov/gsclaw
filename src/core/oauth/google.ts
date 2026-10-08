// Google's OAuth 2.0 web-server flow (with PKCE), used by OAuth mode to learn who the user is and
// obtain a refresh token for Search Console on their behalf.
import type { GoogleOAuthConfig } from '../config.js';
import { base64ToBytes } from '../crypto.js';
import { GscApiError } from '../errors.js';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleTokens {
  accessToken: string;
  /** Seconds since epoch. */
  expiresAt: number;
  refreshToken?: string;
  scope: string[];
  idToken?: string;
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export function googleAuthUrl(
  cfg: GoogleOAuthConfig,
  opts: {
    redirectUri: string;
    scopes: string[];
    state: string;
    codeChallenge: string;
    loginHint?: string;
  },
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: ['openid', 'email', ...opts.scopes].join(' '),
    access_type: 'offline',
    // Always ask, so Google returns a refresh token even for returning users.
    prompt: 'consent select_account',
    include_granted_scopes: 'false',
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (opts.loginHint) params.set('login_hint', opts.loginHint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  fetchImpl: typeof fetch,
  body: Record<string, string>,
  nowSeconds: number,
): Promise<GoogleTokens> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.access_token) {
    throw new GscApiError({
      kind: 'auth',
      status: res.status,
      reason: data.error,
      googleMessage: [data.error, data.error_description].filter(Boolean).join(': '),
      advice:
        data.error === 'invalid_grant'
          ? 'Your Google authorization has expired or was revoked. Sign in to GSClaw again.'
          : 'Google rejected the sign-in. Check GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET and the authorized redirect URI.',
    });
  }
  return {
    accessToken: data.access_token,
    expiresAt: nowSeconds + (data.expires_in ?? 3600),
    refreshToken: data.refresh_token,
    scope: (data.scope ?? '').split(' ').filter(Boolean),
    idToken: data.id_token,
  };
}

export function exchangeGoogleCode(
  cfg: GoogleOAuthConfig,
  opts: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    fetch: typeof fetch;
    nowSeconds: number;
  },
): Promise<GoogleTokens> {
  return tokenRequest(
    opts.fetch,
    {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: opts.codeVerifier,
    },
    opts.nowSeconds,
  );
}

export function refreshGoogleToken(
  cfg: GoogleOAuthConfig,
  opts: { refreshToken: string; fetch: typeof fetch; nowSeconds: number },
): Promise<GoogleTokens> {
  return tokenRequest(
    opts.fetch,
    {
      grant_type: 'refresh_token',
      refresh_token: opts.refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    },
    opts.nowSeconds,
  );
}

/**
 * Reads the identity from Google's ID token. The token was received directly from Google's token
 * endpoint over TLS (not via the browser), so OpenID Connect allows skipping signature validation;
 * we still check issuer, audience and expiry.
 */
export function identityFromIdToken(
  idToken: string | undefined,
  cfg: GoogleOAuthConfig,
  nowSeconds: number,
): GoogleIdentity | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64ToBytes(idToken.split('.')[1] ?? '')),
    ) as {
      iss?: string;
      aud?: string;
      exp?: number;
      sub?: string;
      email?: string;
      email_verified?: boolean;
    };
    if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com')
      return null;
    if (payload.aud !== cfg.clientId) return null;
    if (!payload.exp || payload.exp < nowSeconds - 300) return null;
    if (!payload.sub || !payload.email) return null;
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true,
    };
  } catch {
    return null;
  }
}

/** True when the allowlists permit this identity (no lists configured = everyone). */
export function isAllowed(identity: GoogleIdentity, cfg: GoogleOAuthConfig): boolean {
  if (cfg.allowedEmails.length === 0 && cfg.allowedDomains.length === 0) return true;
  if (!identity.emailVerified) return false;
  if (cfg.allowedEmails.includes(identity.email)) return true;
  const domain = identity.email.split('@')[1] ?? '';
  return cfg.allowedDomains.includes(domain);
}
