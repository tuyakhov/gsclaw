import type { Config } from './config.js';
import { timingSafeEqual } from './crypto.js';
import { publicErrorMessage } from './errors.js';
import { listProperties } from './gsc/sites.js';
import type { Logger } from './log.js';
import type { OAuthServer } from './oauth/server.js';
import { SESSION_TTL } from './oauth/server.js';
import type { Principal } from './principal.js';
import { RateLimiter } from './ratelimit.js';
import type { Runtime } from './runtime.js';
import { clearedSessionCookie, parseCookies, SESSION_COOKIE, sessionCookie } from './session.js';
import { isNewer, latestRelease } from './update-check.js';
import { VERSION } from './version.js';

export interface DashboardApiDeps {
  config: Config;
  runtime: Runtime;
  oauth: OAuthServer;
  logger: Logger;
  platform: string;
  fetch?: typeof fetch;
  now?: () => Date;
  baseUrl: (request: Request, url: URL) => string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * JSON API behind the dashboard. Every data endpoint runs the same tool implementations the MCP
 * server uses (`POST /api/tools/:name`) with the signed-in caller's own credentials, so the dashboard
 * and the AI always see identical numbers.
 */
export function createDashboardApi(deps: DashboardApiDeps) {
  const { config, runtime, logger, oauth } = deps;
  const isOAuth = config.authMode === 'oauth';
  const publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : null;
  const loginLimiter = new RateLimiter(10);

  const isSecure = (url: URL) => !(url.protocol === 'http:' && LOOPBACK.has(url.hostname));

  async function signedIn(request: Request): Promise<Principal | null> {
    return oauth.openSession(parseCookies(request.headers.get('cookie'))[SESSION_COOKIE]);
  }

  /** Same-origin check for state-changing requests (on top of SameSite=Strict cookies). */
  function sameOrigin(request: Request, url: URL): boolean {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    return origin === url.origin || origin === publicOrigin;
  }

  function clientKey(request: Request): string {
    return (
      request.headers.get('cf-connecting-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      'local'
    );
  }

  async function readJson(request: Request): Promise<Record<string, unknown> | null> {
    if (!request.headers.get('content-type')?.includes('application/json')) return null;
    try {
      const body: unknown = await request.json();
      return body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  async function login(request: Request, url: URL): Promise<Response> {
    if (isOAuth) return json({ error: 'Use “Sign in with Google”.' }, 400);
    const limit = loginLimiter.check(clientKey(request));
    if (!limit.ok) {
      return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429, {
        'retry-after': String(limit.retryAfterSeconds),
      });
    }
    const body = await readJson(request);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token || !(await timingSafeEqual(token, config.accessToken!))) {
      logger.warn('dashboard login failed');
      return json({ error: 'That access token is not correct.' }, 401);
    }
    const cookie = sessionCookie(await oauth.ownerSession(), {
      secure: isSecure(url),
      maxAge: SESSION_TTL,
    });
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }

  async function status(principal: Principal, request: Request, url: URL): Promise<Response> {
    const session = runtime.sessionFor(principal);
    const started = Date.now();
    let google: Record<string, unknown>;
    try {
      const properties = await listProperties(session.gsc, { fresh: true });
      google = { ok: true, latency_ms: Date.now() - started, properties };
    } catch (error) {
      const { message, kind } = publicErrorMessage(error);
      google = { ok: false, latency_ms: Date.now() - started, error: message, kind };
    }
    const latest = await latestRelease(deps.fetch);
    const base = deps.baseUrl(request, url);
    const warnings: string[] = [];
    if (!config.publicBaseUrl && !LOOPBACK.has(url.hostname)) {
      warnings.push(
        'PUBLIC_BASE_URL is not set and could not be detected; connection snippets use this page’s address.',
      );
    }
    const g = config.googleOAuth;
    const oauthInfo = g
      ? {
          redirect_uri: `${base}/oauth/google/callback`,
          allowed_domains: g.allowedDomains,
          allowed_email_count: g.allowedEmails.length,
          open_to_anyone: g.allowedDomains.length === 0 && g.allowedEmails.length === 0,
        }
      : null;
    if (oauthInfo?.open_to_anyone) {
      warnings.push(
        'Anyone with a Google account can sign in (each person only sees their own properties). Set ALLOWED_GOOGLE_EMAILS or ALLOWED_GOOGLE_DOMAINS to restrict access.',
      );
    }
    return json({
      version: VERSION,
      latest_version: latest,
      update_available: latest !== null && isNewer(latest, VERSION),
      platform: deps.platform,
      auth_mode: config.authMode,
      identity: session.gsc.identity,
      writes_enabled: config.allowWrites,
      secret_path_enabled: !isOAuth && config.secretPath,
      public_base_url: config.publicBaseUrl ?? null,
      rate_limit_per_minute: config.rateLimitPerMinute,
      activity_persistent: runtime.activity.persistent,
      oauth: oauthInfo,
      google,
      warnings,
    });
  }

  async function runTool(name: string, request: Request, principal: Principal): Promise<Response> {
    const session = runtime.sessionFor(principal);
    const tool = session.tools.find((t) => t.name === name && !t.write);
    if (!tool) return json({ error: `Unknown tool: ${name}` }, 404);
    const body = (await readJson(request)) ?? {};
    const parsed = tool.input.safeParse(body);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return json({ error: message }, 400);
    }
    try {
      return json({ result: await tool.run(session.ctx, parsed.data) });
    } catch (error) {
      const { message, kind } = publicErrorMessage(error);
      if (kind === 'internal') logger.error('dashboard tool failed', { tool: name, error });
      return json({ error: message, kind }, kind === 'internal' ? 500 : 400);
    }
  }

  return {
    async handle(request: Request, url: URL, path: string): Promise<Response> {
      const method = request.method;
      if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(request, url)) {
        return json({ error: 'Cross-origin request rejected.' }, 403);
      }

      if (path === '/api/session') {
        if (method === 'GET') {
          const principal = await signedIn(request);
          return json({
            authenticated: principal !== null,
            auth_mode: config.authMode,
            login: isOAuth ? 'google' : 'token',
            email: principal?.email ?? null,
          });
        }
        if (method === 'POST') return login(request, url);
        if (method === 'DELETE') {
          return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie(isSecure(url)) });
        }
        return json({ error: 'Method not allowed' }, 405);
      }

      const principal = await signedIn(request);
      if (!principal) return json({ error: 'Sign in required.' }, 401);

      if (path === '/api/status' && method === 'GET') return status(principal, request, url);
      if (path === '/api/connect' && method === 'GET') {
        const base = deps.baseUrl(request, url);
        return json({
          base_url: base,
          mcp_url: `${base}/mcp`,
          auth_mode: config.authMode,
          secret_path_enabled: !isOAuth && config.secretPath,
        });
      }
      if (path === '/api/connect/secret' && method === 'GET') {
        return isOAuth
          ? json({ error: 'Not available in OAuth mode.' }, 404)
          : json({ access_token: config.accessToken });
      }
      if (path === '/api/activity' && method === 'GET') {
        // In OAuth mode each person only sees their own calls.
        const entries = runtime.activity
          .list()
          .filter((e) => !isOAuth || e.user === principal.email);
        return json({ persistent: runtime.activity.persistent, entries });
      }
      const toolMatch = /^\/api\/tools\/([a-z_]+)$/.exec(path);
      if (toolMatch && method === 'POST') return runTool(toolMatch[1]!, request, principal);

      return json({ error: 'Not found' }, 404);
    },
  };
}
