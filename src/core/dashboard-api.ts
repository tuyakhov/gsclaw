import type { Config } from './config.js';
import { timingSafeEqual } from './crypto.js';
import { publicErrorMessage } from './errors.js';
import { listProperties } from './gsc/sites.js';
import type { Logger } from './log.js';
import { RateLimiter } from './ratelimit.js';
import type { Runtime } from './runtime.js';
import {
  clearedSessionCookie,
  parseCookies,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  sessionCookie,
  signSession,
  verifySession,
} from './session.js';
import { isNewer, latestRelease } from './update-check.js';
import { VERSION } from './version.js';

export interface DashboardApiDeps {
  config: Config;
  runtime: Runtime;
  logger: Logger;
  platform: string;
  fetch?: typeof fetch;
  now?: () => Date;
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
 * server uses (`POST /api/tools/:name`), so the dashboard and the AI always see identical numbers.
 */
export function createDashboardApi(deps: DashboardApiDeps) {
  const { config, runtime, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const secret = config.accessToken!;
  const publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : null;
  const loginLimiter = new RateLimiter(10);
  const readTools = new Map(runtime.tools.filter((t) => !t.write).map((t) => [t.name, t]));

  const isSecure = (url: URL) => !(url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  const nowSeconds = () => Math.floor(now().getTime() / 1000);

  async function authenticated(request: Request): Promise<boolean> {
    const cookies = parseCookies(request.headers.get('cookie'));
    return (await verifySession(cookies[SESSION_COOKIE], secret, nowSeconds())) !== null;
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
    const limit = loginLimiter.check(clientKey(request));
    if (!limit.ok) {
      return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429, {
        'retry-after': String(limit.retryAfterSeconds),
      });
    }
    const body = await readJson(request);
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token || !(await timingSafeEqual(token, secret))) {
      logger.warn('dashboard login failed');
      return json({ error: 'That access token is not correct.' }, 401);
    }
    const value = await signSession(
      { sub: 'owner', exp: nowSeconds() + SESSION_MAX_AGE_SECONDS },
      secret,
    );
    return json({ ok: true }, 200, {
      'set-cookie': sessionCookie(value, { secure: isSecure(url) }),
    });
  }

  async function status(url: URL): Promise<Response> {
    const started = Date.now();
    let google: Record<string, unknown>;
    try {
      const properties = await listProperties(runtime.gsc, { fresh: true });
      google = { ok: true, latency_ms: Date.now() - started, properties };
    } catch (error) {
      const { message, kind } = publicErrorMessage(error);
      google = { ok: false, latency_ms: Date.now() - started, error: message, kind };
    }
    const latest = await latestRelease(deps.fetch);
    const warnings: string[] = [];
    if (!config.publicBaseUrl && !LOOPBACK.has(url.hostname)) {
      warnings.push(
        'PUBLIC_BASE_URL is not set and could not be detected; connection snippets use this page’s address.',
      );
    }
    return json({
      version: VERSION,
      latest_version: latest,
      update_available: latest !== null && isNewer(latest, VERSION),
      platform: deps.platform,
      auth_mode: config.authMode,
      identity: runtime.gsc.identity,
      writes_enabled: config.allowWrites,
      secret_path_enabled: config.secretPath,
      public_base_url: config.publicBaseUrl ?? null,
      rate_limit_per_minute: config.rateLimitPerMinute,
      activity_persistent: runtime.activity.persistent,
      google,
      warnings,
    });
  }

  async function runTool(name: string, request: Request): Promise<Response> {
    const tool = readTools.get(name);
    if (!tool) return json({ error: `Unknown tool: ${name}` }, 404);
    const body = (await readJson(request)) ?? {};
    const parsed = tool.input.safeParse(body);
    if (!parsed.success) {
      return json(
        { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        400,
      );
    }
    try {
      return json({ result: await tool.run(runtime.ctx, parsed.data) });
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
          return json({
            authenticated: await authenticated(request),
            auth_mode: config.authMode,
            login: 'token',
          });
        }
        if (method === 'POST') return login(request, url);
        if (method === 'DELETE') {
          return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie(isSecure(url)) });
        }
        return json({ error: 'Method not allowed' }, 405);
      }

      if (!(await authenticated(request))) return json({ error: 'Sign in required.' }, 401);

      if (path === '/api/status' && method === 'GET') return status(url);
      if (path === '/api/connect' && method === 'GET') {
        const base = config.publicBaseUrl ?? url.origin;
        return json({
          base_url: base,
          mcp_url: `${base}/mcp`,
          auth_mode: config.authMode,
          secret_path_enabled: config.secretPath,
        });
      }
      if (path === '/api/connect/secret' && method === 'GET') return json({ access_token: secret });
      if (path === '/api/activity' && method === 'GET') {
        return json({ persistent: runtime.activity.persistent, entries: runtime.activity.list() });
      }
      const toolMatch = /^\/api\/tools\/([a-z_]+)$/.exec(path);
      if (toolMatch && method === 'POST') return runTool(toolMatch[1]!, request);

      return json({ error: 'Not found' }, 404);
    },
  };
}
