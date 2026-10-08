// GSClaw's built-in OAuth 2.1 authorization server for MCP clients (claude.ai, ChatGPT, Claude Code,
// Cursor, VS Code…). Stateless: every artifact (client registration, authorization code, access and
// refresh token, Google round-trip state) is a sealed, expiring blob.
//
// Service-account mode: the owner approves a client by entering GSCLAW_ACCESS_TOKEN on the consent page.
// OAuth mode: the consent page hands off to Google; tokens wrap the user's Google credentials.
import type { Config } from '../config.js';
import { base64UrlEncode, randomToken, sha256, timingSafeEqual } from '../crypto.js';
import { GscApiError } from '../errors.js';
import { SCOPE_READONLY, SCOPE_READWRITE } from '../gsc/auth.js';
import type { Logger } from '../log.js';
import { HTML_SECURITY_HEADERS } from '../pages.js';
import { SCOPE_READ, SCOPE_WRITE, type Principal } from '../principal.js';
import { RateLimiter } from '../ratelimit.js';
import type { Sealer } from '../seal.js';
import { parseCookies, sessionCookie, STATE_COOKIE, stateCookie } from '../session.js';
import { OAuthError, redirectUriMatches, registerClient, resolveClient } from './clients.js';
import {
  exchangeGoogleCode,
  googleAuthUrl,
  identityFromIdToken,
  isAllowed,
  refreshGoogleToken,
} from './google.js';
import { consentHeaders, googleConsentPage, oauthErrorPage, ownerConsentPage } from './pages.js';

const REQUEST_TTL = 15 * 60;
const CODE_TTL = 60;
const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 24 * 3600;
export const SESSION_TTL = 7 * 24 * 3600;

/** Compact principal stored inside sealed tokens. */
interface SealedPrincipal {
  k: 'owner' | 'user';
  sub: string;
  email?: string;
  g?: { at?: string; ex?: number; rt: string; sc: string[] };
}

/** A validated authorization request, sealed into the consent form and the Google state. */
interface AuthRequest {
  cid: string;
  cn: string;
  ru: string;
  cc: string;
  st?: string;
  sc: string[];
  res: string;
}

interface GoogleState {
  req?: AuthRequest;
  dash?: boolean;
  /** PKCE verifier for the Google round-trip. */
  v: string;
  /** Browser binding: must match the state cookie set when the round-trip started. */
  b: string;
}

interface CodePayload extends Omit<AuthRequest, 'st'> {
  p: SealedPrincipal;
}

interface TokenPayload {
  cid: string;
  cn: string;
  sc: string[];
  aud: string;
  p: SealedPrincipal;
}

export interface SessionPayload {
  p: SealedPrincipal;
}

export interface OAuthServerDeps {
  config: Config;
  sealer: Sealer;
  logger: Logger;
  fetch: typeof fetch;
  now: () => Date;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      ...CORS,
      ...headers,
    },
  });
}

function html(
  body: string,
  status = 200,
  headers: Record<string, string> = HTML_SECURITY_HEADERS,
): Response {
  return new Response(body, { status, headers });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status: 302,
    headers: { location, 'cache-control': 'no-store', ...headers },
  });
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.href;
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]),
      );
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function toPrincipal(
  p: SealedPrincipal,
  extra: Pick<Principal, 'scopes' | 'via' | 'clientId' | 'clientName'>,
): Principal {
  return {
    kind: p.k,
    sub: p.sub,
    email: p.email,
    ...extra,
    google: p.g
      ? { accessToken: p.g.at, expiresAt: p.g.ex, refreshToken: p.g.rt, scope: p.g.sc }
      : undefined,
  };
}

export function createOAuthServer(deps: OAuthServerDeps) {
  const { config, sealer, logger } = deps;
  const nowSeconds = () => Math.floor(deps.now().getTime() / 1000);
  const consentLimiter = new RateLimiter(10);
  const scopesSupported = config.allowWrites ? [SCOPE_READ, SCOPE_WRITE] : [SCOPE_READ];
  const google = config.googleOAuth;
  const clientDeps = { sealer, fetch: deps.fetch, extraHosts: config.oauthRedirectHosts };

  const resourceUrl = (base: string) => `${base}/mcp`;
  const metadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource/mcp`;

  function grantedScopes(requested: string | undefined | null): string[] {
    const wanted = (requested ?? '').split(/\s+/).filter((s) => scopesSupported.includes(s));
    const scopes = new Set(wanted.length > 0 ? wanted : [SCOPE_READ]);
    scopes.add(SCOPE_READ);
    return [...scopes];
  }

  const googleScopeFor = (scopes: string[]) =>
    scopes.includes(SCOPE_WRITE) ? SCOPE_READWRITE : SCOPE_READONLY;

  function protectedResourceMetadata(base: string) {
    return {
      resource: resourceUrl(base),
      authorization_servers: [base],
      scopes_supported: scopesSupported,
      bearer_methods_supported: ['header'],
      resource_name: 'GSClaw',
      resource_documentation: 'https://github.com/tuyakhov/gsclaw#readme',
    };
  }

  function authorizationServerMetadata(base: string) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      scopes_supported: scopesSupported,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://github.com/tuyakhov/gsclaw#readme',
    };
  }

  async function issueCode(req: AuthRequest, p: SealedPrincipal, base: string): Promise<Response> {
    const code = await sealer.seal(
      'code',
      {
        cid: req.cid,
        cn: req.cn,
        ru: req.ru,
        cc: req.cc,
        sc: req.sc,
        res: req.res,
        p,
      } satisfies CodePayload,
      CODE_TTL,
    );
    logger.info('oauth code issued', { client: req.cn, kind: p.k });
    return redirect(withParams(req.ru, { code, state: req.st, iss: base }));
  }

  const clientError = (req: AuthRequest, error: string, description: string, base: string) =>
    redirect(
      withParams(req.ru, { error, error_description: description, state: req.st, iss: base }),
    );

  async function startGoogle(
    target: Pick<GoogleState, 'req' | 'dash'>,
    scopes: string[],
    base: string,
  ): Promise<Response> {
    const state: GoogleState = { ...target, v: randomToken(32), b: randomToken(24) };
    const challenge = base64UrlEncode(await sha256(state.v));
    const sealedState = await sealer.seal('state', state, REQUEST_TTL);
    const secure = new URL(base).protocol === 'https:';
    return redirect(
      googleAuthUrl(google!, {
        redirectUri: `${base}/oauth/google/callback`,
        scopes: [googleScopeFor(scopes)],
        state: sealedState,
        codeChallenge: challenge,
      }),
      { 'set-cookie': stateCookie(state.b, { secure, maxAge: REQUEST_TTL }) },
    );
  }

  /** GET /oauth/authorize: validate, then show the consent page. */
  async function authorize(url: URL, base: string): Promise<Response> {
    const q = url.searchParams;
    const clientId = q.get('client_id');
    if (!clientId) return html(oauthErrorPage('Invalid request', 'client_id is missing.'), 400);
    let client;
    try {
      client = await resolveClient(clientId, clientDeps);
    } catch (error) {
      return html(
        oauthErrorPage('Unknown app', error instanceof Error ? error.message : 'Unknown client.'),
        400,
      );
    }
    const requested =
      q.get('redirect_uri') ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : '');
    if (!client.redirectUris.some((r) => redirectUriMatches(r, requested))) {
      return html(
        oauthErrorPage('Invalid redirect', 'The redirect_uri is not registered for this app.'),
        400,
      );
    }
    const req: AuthRequest = {
      cid: clientId,
      cn: client.name,
      ru: requested,
      cc: q.get('code_challenge') ?? '',
      st: q.get('state') ?? undefined,
      sc: grantedScopes(q.get('scope')),
      res: resourceUrl(base),
    };
    if (q.get('response_type') !== 'code')
      return clientError(
        req,
        'unsupported_response_type',
        'Only response_type=code is supported.',
        base,
      );
    if (!req.cc || q.get('code_challenge_method') !== 'S256') {
      return clientError(
        req,
        'invalid_request',
        'PKCE with code_challenge_method=S256 is required.',
        base,
      );
    }
    const resource = q.get('resource');
    if (resource && resource.replace(/\/$/, '') !== req.res) {
      return clientError(req, 'invalid_target', `This server's resource is ${req.res}.`, base);
    }
    const sealedReq = await sealer.seal('request', req, REQUEST_TTL);
    const info = {
      clientName: client.name,
      redirectUri: req.ru,
      request: sealedReq,
      canWrite: req.sc.includes(SCOPE_WRITE),
    };
    return config.authMode === 'oauth'
      ? html(googleConsentPage(info), 200, consentHeaders(req.ru, ['https://accounts.google.com']))
      : html(ownerConsentPage(info), 200, consentHeaders(req.ru));
  }

  /** POST /oauth/authorize: the consent decision. */
  async function decide(request: Request, base: string): Promise<Response> {
    const form = await readForm(request);
    const req = await sealer.open<AuthRequest>('request', form.request);
    if (!req)
      return html(
        oauthErrorPage(
          'Sign-in expired',
          'This sign-in page expired. Start the connection again from your app.',
        ),
        400,
      );
    if (form.decision !== 'allow')
      return clientError(req, 'access_denied', 'The request was denied.', base);

    if (config.authMode === 'oauth') return startGoogle({ req }, req.sc, base);

    const ip =
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      'local';
    const info = {
      clientName: req.cn,
      redirectUri: req.ru,
      request: form.request!,
      canWrite: req.sc.includes(SCOPE_WRITE),
    };
    if (!consentLimiter.check(ip).ok) {
      return html(
        ownerConsentPage({ ...info, error: 'Too many attempts. Wait a minute and try again.' }),
        429,
        consentHeaders(req.ru),
      );
    }
    if (!form.token || !(await timingSafeEqual(form.token.trim(), config.accessToken!))) {
      logger.warn('oauth owner consent: wrong access token');
      return html(
        ownerConsentPage({ ...info, error: 'That access token is not correct.' }),
        401,
        consentHeaders(req.ru),
      );
    }
    return issueCode(req, { k: 'owner', sub: 'owner' }, base);
  }

  /** GET /oauth/google/callback (OAuth mode): finish Google sign-in for an MCP client or the dashboard. */
  async function googleCallback(request: Request, url: URL, base: string): Promise<Response> {
    const state = await sealer.open<GoogleState>('state', url.searchParams.get('state'));
    const bound = parseCookies(request.headers.get('cookie'))[STATE_COOKIE];
    if (!state || !google || !bound || !(await timingSafeEqual(bound, state.b)))
      return html(
        oauthErrorPage(
          'Sign-in expired',
          'This sign-in expired or was started in a different browser. Please start again.',
        ),
        400,
      );
    const fail = (error: string, description: string, dashCode: string) =>
      state.req
        ? clientError(state.req, error, description, base)
        : redirect(`/?login_error=${dashCode}`);

    if (url.searchParams.get('error') || !url.searchParams.get('code'))
      return fail('access_denied', 'Google sign-in was cancelled.', 'cancelled');

    let tokens;
    try {
      tokens = await exchangeGoogleCode(google, {
        code: url.searchParams.get('code')!,
        redirectUri: `${base}/oauth/google/callback`,
        codeVerifier: state.v,
        fetch: deps.fetch,
        nowSeconds: nowSeconds(),
      });
    } catch (error) {
      logger.warn('google code exchange failed', { error });
      return fail('server_error', 'Google sign-in failed.', 'google_error');
    }
    const identity = identityFromIdToken(tokens.idToken, google, nowSeconds());
    if (!identity)
      return fail('server_error', 'Google did not return a verified identity.', 'google_error');
    if (!isAllowed(identity, google)) {
      logger.warn('google account not allowed', { domain: identity.email.split('@')[1] });
      return fail(
        'access_denied',
        `${identity.email} is not allowed to use this GSClaw deployment.`,
        'not_allowed',
      );
    }
    const needed = state.req ? googleScopeFor(state.req.sc) : SCOPE_READONLY;
    const granted =
      tokens.scope.includes(needed) ||
      (needed === SCOPE_READONLY && tokens.scope.includes(SCOPE_READWRITE));
    if (!granted)
      return fail(
        'access_denied',
        'Search Console access was not granted. Try again and keep the Search Console permission ticked.',
        'scope',
      );
    if (!tokens.refreshToken) {
      return fail(
        'server_error',
        'Google did not return a refresh token. Remove GSClaw from your Google account’s third-party access and try again.',
        'google_error',
      );
    }

    const p: SealedPrincipal = {
      k: 'user',
      sub: identity.sub,
      email: identity.email,
      g: {
        at: tokens.accessToken,
        ex: tokens.expiresAt,
        rt: tokens.refreshToken,
        sc: tokens.scope,
      },
    };
    if (state.dash) {
      const value = await sealer.seal('session', { p } satisfies SessionPayload, SESSION_TTL);
      const secure = new URL(base).protocol === 'https:';
      return redirect('/', { 'set-cookie': sessionCookie(value, { secure, maxAge: SESSION_TTL }) });
    }
    return issueCode(state.req!, p, base);
  }

  async function issueTokens(t: Omit<TokenPayload, 'p'>, p: SealedPrincipal): Promise<Response> {
    let ttl = ACCESS_TTL;
    if (p.g?.ex) ttl = Math.max(300, Math.min(ACCESS_TTL, p.g.ex - nowSeconds() - 120));
    const access = await sealer.seal('access', { ...t, p } satisfies TokenPayload, ttl);
    // The refresh token keeps only the Google refresh token; access tokens are re-derived on refresh.
    const refreshPrincipal: SealedPrincipal = p.g ? { ...p, g: { rt: p.g.rt, sc: p.g.sc } } : p;
    const refresh = await sealer.seal(
      'refresh',
      { ...t, p: refreshPrincipal } satisfies TokenPayload,
      REFRESH_TTL,
    );
    return json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refresh,
      scope: t.sc.join(' '),
    });
  }

  /** POST /oauth/token */
  async function token(request: Request): Promise<Response> {
    const form = await readForm(request);
    const basic = request.headers.get('authorization');
    let clientId = form.client_id;
    if (!clientId && basic?.startsWith('Basic ')) {
      try {
        clientId = decodeURIComponent(atob(basic.slice(6)).split(':')[0] ?? '');
      } catch {
        clientId = undefined;
      }
    }
    const err = (error: string, description: string, status = 400) =>
      json({ error, error_description: description }, status);

    if (form.grant_type === 'authorization_code') {
      const code = await sealer.open<CodePayload>('code', form.code);
      if (!code) return err('invalid_grant', 'The authorization code is invalid or expired.');
      if (code.cid !== clientId)
        return err('invalid_grant', 'The code was issued to another client.');
      if (!form.redirect_uri || !redirectUriMatches(code.ru, form.redirect_uri))
        return err('invalid_grant', 'redirect_uri does not match.');
      if (!form.code_verifier || base64UrlEncode(await sha256(form.code_verifier)) !== code.cc) {
        return err('invalid_grant', 'PKCE verification failed.');
      }
      if (form.resource && form.resource.replace(/\/$/, '') !== code.res)
        return err('invalid_target', 'Unknown resource.');
      return issueTokens({ cid: code.cid, cn: code.cn, sc: code.sc, aud: code.res }, code.p);
    }

    if (form.grant_type === 'refresh_token') {
      const rt = await sealer.open<TokenPayload>('refresh', form.refresh_token);
      if (!rt) return err('invalid_grant', 'The refresh token is invalid or expired.');
      if (clientId && clientId !== rt.cid)
        return err('invalid_grant', 'The refresh token was issued to another client.');
      let scopes = rt.sc;
      if (form.scope) {
        const narrowed = form.scope.split(/\s+/).filter((s) => rt.sc.includes(s));
        if (narrowed.length === 0)
          return err('invalid_scope', 'Requested scope exceeds the original grant.');
        scopes = narrowed;
      }
      let p = rt.p;
      if (p.g && google) {
        try {
          const fresh = await refreshGoogleToken(google, {
            refreshToken: p.g.rt,
            fetch: deps.fetch,
            nowSeconds: nowSeconds(),
          });
          p = {
            ...p,
            g: {
              at: fresh.accessToken,
              ex: fresh.expiresAt,
              rt: fresh.refreshToken ?? p.g.rt,
              sc: p.g.sc,
            },
          };
        } catch (error) {
          if (error instanceof GscApiError && error.reason === 'invalid_grant') {
            return err('invalid_grant', 'Google access was revoked or expired. Sign in again.');
          }
          return err(
            'temporarily_unavailable',
            'Could not refresh Google credentials. Try again.',
            503,
          );
        }
      }
      return issueTokens({ cid: rt.cid, cn: rt.cn, sc: scopes, aud: rt.aud }, p);
    }

    return err('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }

  return {
    resourceUrl,

    /** WWW-Authenticate value for /mcp 401s (RFC 9728 discovery). */
    challenge(base: string, error?: 'invalid_token'): string {
      const parts = [
        `resource_metadata="${metadataUrl(base)}"`,
        `scope="${scopesSupported.join(' ')}"`,
      ];
      if (error) parts.push(`error="${error}"`);
      return `Bearer ${parts.join(', ')}`;
    },

    /** Validates a GSClaw-issued access token for this resource. */
    async verifyAccessToken(token: string, base: string): Promise<Principal | null> {
      const t = await sealer.open<TokenPayload>('access', token);
      if (!t || t.aud !== resourceUrl(base)) return null;
      if ((config.authMode === 'oauth') !== (t.p.k === 'user')) return null;
      return toPrincipal(t.p, { scopes: t.sc, via: 'oauth', clientId: t.cid, clientName: t.cn });
    },

    /** Reads a dashboard session cookie value. */
    async openSession(value: string | undefined): Promise<Principal | null> {
      const s = await sealer.open<SessionPayload>('session', value);
      if (!s) return null;
      if ((config.authMode === 'oauth') !== (s.p.k === 'user')) return null;
      return toPrincipal(s.p, { scopes: [SCOPE_READ], via: 'session' });
    },

    async ownerSession(): Promise<string> {
      return sealer.seal(
        'session',
        { p: { k: 'owner', sub: 'owner' } } satisfies SessionPayload,
        SESSION_TTL,
      );
    },

    /** Routes /.well-known/* and /oauth/*; returns null for anything else. */
    async handle(request: Request, url: URL, path: string, base: string): Promise<Response | null> {
      const method = request.method;
      const isWellKnown = path.startsWith('/.well-known/');
      if (!isWellKnown && !path.startsWith('/oauth/')) return null;
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

      try {
        if (
          path === '/.well-known/oauth-protected-resource' ||
          path === '/.well-known/oauth-protected-resource/mcp'
        ) {
          return json(protectedResourceMetadata(base));
        }
        if (
          path === '/.well-known/oauth-authorization-server' ||
          path === '/.well-known/oauth-authorization-server/mcp'
        ) {
          return json(authorizationServerMetadata(base));
        }
        if (path === '/oauth/register' && method === 'POST') {
          const body: unknown = await request.json().catch(() => null);
          return json(await registerClient(body, sealer, config.oauthRedirectHosts), 201);
        }
        if (path === '/oauth/authorize' && method === 'GET') return authorize(url, base);
        if (path === '/oauth/authorize' && method === 'POST') return decide(request, base);
        if (path === '/oauth/token' && method === 'POST') return token(request);
        if (path === '/oauth/google/callback' && method === 'GET')
          return googleCallback(request, url, base);
        if (path === '/oauth/google/start' && method === 'GET' && google) {
          return startGoogle({ dash: true }, [SCOPE_READ], base);
        }
      } catch (error) {
        if (error instanceof OAuthError) {
          return json({ error: error.error, error_description: error.message }, error.status);
        }
        throw error;
      }
      return json({ error: 'not_found' }, 404);
    },
  };
}

export type OAuthServer = ReturnType<typeof createOAuthServer>;
