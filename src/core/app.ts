import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { clientLabel } from './activity.js';
import { loadConfig, type ConfigIssue, type Env } from './config.js';
import { timingSafeEqual } from './crypto.js';
import { createLogger, type Logger, type LogWriter } from './log.js';
import { buildMcpServer } from './mcp.js';
import { HTML_SECURITY_HEADERS, runningPage, setupPage } from './pages.js';
import { RateLimiter } from './ratelimit.js';
import { createRuntime, type Runtime } from './runtime.js';
import { VERSION } from './version.js';

export interface PlatformOptions {
  name: 'node' | 'vercel' | 'netlify' | 'cloudflare' | 'test';
  /** Outbound fetch for Google APIs (tests inject a mock). */
  fetch?: typeof fetch;
  logWriter?: LogWriter;
  /** Server is bound to loopback: enforce Host-header checks and allow localhost origins. */
  localOnly?: boolean;
  now?: () => Date;
}

export interface App {
  fetch(request: Request): Promise<Response>;
  /** Configuration problems; non-empty means the app only serves the setup page. */
  readonly setupErrors: ConfigIssue[];
  readonly warnings: string[];
  readonly runtime: Runtime | null;
}

const MAX_BODY_BYTES = 1_000_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const MCP_CORS_HEADERS = {
  'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id, last-event-id',
  'access-control-expose-headers': 'www-authenticate, mcp-protocol-version, mcp-session-id',
  'access-control-max-age': '600',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_SECURITY_HEADERS });
}

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });

function hostnameOf(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/** Builds the web-standard request handler shared by every adapter. */
export function createApp(env: Env, platform: PlatformOptions): App {
  const loaded = loadConfig(env, { transport: 'http' });
  if (!loaded.ok) {
    const logger = createLogger({ write: platform.logWriter, base: { platform: platform.name } });
    logger.error('configuration invalid; serving setup page only', {
      issues: loaded.errors.map((e) => `${e.variable ?? ''} ${e.message}`.trim()),
    });
    return {
      setupErrors: loaded.errors,
      warnings: [],
      runtime: null,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/healthz') return json({ status: 'setup_required', version: VERSION }, 503);
        if (path === '/' && (request.method === 'GET' || request.method === 'HEAD')) {
          return html(setupPage(loaded.errors), 503);
        }
        return json(
          {
            error: 'setup_required',
            error_description: 'This GSClaw deployment is not configured.',
          },
          503,
        );
      },
    };
  }

  const { config } = loaded;
  const runtime = createRuntime(config, {
    fetch: platform.fetch,
    logWriter: platform.logWriter,
    now: platform.now,
    logFields: { platform: platform.name },
  });
  const { logger } = runtime;
  for (const warning of loaded.warnings) logger.warn(warning);

  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const publicOrigin = config.publicBaseUrl ? new URL(config.publicBaseUrl).origin : null;

  const mcp: McpHttpHandler = createMcpHandler(
    ({ authInfo }) =>
      buildMcpServer({
        tools: runtime.tools,
        ctx: runtime.ctx,
        logger,
        activity: runtime.activity,
        client: typeof authInfo?.extra?.client === 'string' ? authInfo.extra.client : 'unknown',
      }),
    {
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: (error) => logger.debug('mcp transport error', { error }),
    },
  );

  const originAllowed = (origin: string, requestUrl: URL): boolean => {
    if (origin === requestUrl.origin || origin === publicOrigin) return true;
    if (config.allowedOrigins.includes(origin)) return true;
    if (platform.localOnly) {
      const host = hostnameOf(origin.replace(/^https?:\/\//, ''));
      return host !== null && LOOPBACK_HOSTS.has(host);
    }
    return false;
  };

  const corsHeaders = (origin: string | null): Record<string, string> =>
    origin ? { 'access-control-allow-origin': origin, vary: 'Origin', ...MCP_CORS_HEADERS } : {};

  async function handleMcp(
    request: Request,
    url: URL,
    path: string,
    log: Logger,
  ): Promise<Response> {
    const origin = request.headers.get('origin');
    if (origin && !originAllowed(origin, url)) {
      log.warn('rejected request from disallowed origin', { origin });
      return json(
        {
          error: 'forbidden',
          error_description: 'Origin not allowed. Add it to GSCLAW_ALLOWED_ORIGINS.',
        },
        403,
      );
    }
    if (platform.localOnly) {
      const host = hostnameOf(request.headers.get('host'));
      if (!host || !LOOPBACK_HOSTS.has(host))
        return json({ error: 'forbidden', error_description: 'Invalid Host header.' }, 403);
    }
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    // Authenticate: bearer header on /mcp, or the secret path /mcp/<token>.
    const accessToken = config.accessToken!;
    let via: 'bearer' | 'secret_path';
    if (path === '/mcp') {
      const header = request.headers.get('authorization') ?? '';
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token || !(await timingSafeEqual(token, accessToken))) {
        return json(
          {
            error: 'invalid_token',
            error_description:
              "Missing or invalid credentials. Send 'Authorization: Bearer <GSCLAW_ACCESS_TOKEN>'.",
          },
          401,
          {
            'www-authenticate': token
              ? 'Bearer realm="gsclaw", error="invalid_token"'
              : 'Bearer realm="gsclaw"',
            ...corsHeaders(origin),
          },
        );
      }
      via = 'bearer';
    } else {
      const secret = path.slice('/mcp/'.length);
      // Wrong secret paths are indistinguishable from any other unknown URL.
      if (
        !config.secretPath ||
        secret.includes('/') ||
        !(await timingSafeEqual(decodeURIComponent(secret), accessToken))
      ) {
        return notFound();
      }
      via = 'secret_path';
    }

    const limit = limiter.check('owner');
    if (!limit.ok) {
      return json(
        { error: 'rate_limited', error_description: 'Too many requests. Slow down and retry.' },
        429,
        {
          'retry-after': String(limit.retryAfterSeconds),
          ...corsHeaders(origin),
        },
      );
    }

    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && body.length > MAX_BODY_BYTES) return json({ error: 'payload_too_large' }, 413);

    // Hand the SDK a clean request: canonical URL, no credentials.
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    headers.delete('cookie');
    const clean = new Request(new URL('/mcp', url), { method: request.method, headers, body });

    const response = await mcp.fetch(clean, {
      authInfo: {
        token: 'redacted',
        clientId: 'owner',
        scopes: runtime.tools.some((t) => t.write) ? ['read', 'write'] : ['read'],
        extra: { client: clientLabel(request.headers.get('user-agent')), via },
      },
    });
    const out = new Response(response.body, response);
    out.headers.set('cache-control', 'no-store');
    for (const [k, v] of Object.entries(corsHeaders(origin))) out.headers.set(k, v);
    return out;
  }

  async function route(request: Request, log: Logger): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (path === '/healthz') return json({ status: 'ok', version: VERSION });
    if (path === '/mcp' || path.startsWith('/mcp/')) return handleMcp(request, url, path, log);
    if (path === '/' && (request.method === 'GET' || request.method === 'HEAD'))
      return html(runningPage());
    return notFound();
  }

  return {
    setupErrors: [],
    warnings: loaded.warnings,
    runtime,
    async fetch(request) {
      const started = Date.now();
      const url = new URL(request.url);
      // Never log the secret path segment.
      const logPath = url.pathname.startsWith('/mcp/') ? '/mcp/<secret>' : url.pathname;
      const log = logger.child({ method: request.method, path: logPath });
      let response: Response;
      try {
        response = await route(request, log);
      } catch (error) {
        log.error('unhandled error', { error });
        response = json({ error: 'internal_error' }, 500);
      }
      if (logPath !== '/healthz')
        log.info('request', { status: response.status, ms: Date.now() - started });
      return response;
    },
  };
}
