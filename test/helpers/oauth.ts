// Test helpers for OAuth flows: an in-memory MCP OAuthClientProvider and a fake Google OAuth server.
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import { base64UrlEncode } from '../../src/core/crypto.js';

export const REDIRECT_URI = 'http://127.0.0.1:43123/callback';

/** Minimal in-memory OAuth client, like Claude Code's: loopback redirect, public client. */
export function memoryProvider(opts: { clientMetadataUrl?: string; name?: string } = {}) {
  const store: {
    client?: unknown;
    tokens?: unknown;
    verifier?: string;
    authorizationUrl?: URL;
  } = {};
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT_URI;
    },
    clientMetadataUrl: opts.clientMetadataUrl,
    get clientMetadata() {
      return {
        client_name: opts.name ?? 'Test Client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    clientInformation: () => store.client as never,
    saveClientInformation: (info) => {
      store.client = info;
    },
    tokens: () => store.tokens as never,
    saveTokens: (tokens) => {
      store.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      store.authorizationUrl = url;
    },
    saveCodeVerifier: (v) => {
      store.verifier = v;
    },
    codeVerifier: () => store.verifier!,
  };
  return { provider, store };
}

/** Pulls the sealed request out of a consent page. */
export function sealedRequestFrom(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  if (!match) throw new Error('consent page has no sealed request');
  return match[1]!.replace(/&amp;/g, '&');
}

export interface GoogleUser {
  sub: string;
  email: string;
  emailVerified?: boolean;
  /** Scopes the user grants (granular consent). */
  scopes?: string[];
}

function fakeIdToken(payload: Record<string, unknown>): string {
  return `${base64UrlEncode('{"alg":"none"}')}.${base64UrlEncode(JSON.stringify(payload))}.sig`;
}

/**
 * Wraps a fetch so Google's OAuth token endpoint answers authorization_code / refresh_token grants
 * for the given users (each auth code is "code-<sub>"). Everything else goes to `inner`.
 */
export function withFakeGoogle(
  inner: typeof fetch,
  users: GoogleUser[],
  clientId: string,
  nowSeconds: () => number,
) {
  const exchanges: Record<string, string>[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body: Record<string, string> =
      typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    if (
      url === 'https://oauth2.googleapis.com/token' &&
      body.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    ) {
      exchanges.push(body);
      const user =
        body.grant_type === 'authorization_code'
          ? users.find((u) => body.code === `code-${u.sub}`)
          : users.find((u) => body.refresh_token === `refresh-${u.sub}`);
      if (!user) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const scope = [
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        ...(user.scopes ?? ['https://www.googleapis.com/auth/webmasters.readonly']),
      ];
      return Response.json({
        access_token: `ya29.${user.sub}-${exchanges.length}`,
        expires_in: 3599,
        refresh_token: body.grant_type === 'authorization_code' ? `refresh-${user.sub}` : undefined,
        scope: scope.join(' '),
        token_type: 'Bearer',
        id_token: fakeIdToken({
          iss: 'https://accounts.google.com',
          aud: clientId,
          sub: user.sub,
          email: user.email,
          email_verified: user.emailVerified ?? true,
          exp: nowSeconds() + 3600,
        }),
      });
    }
    return inner(input, init);
  };
  return { fetch: impl, exchanges };
}
