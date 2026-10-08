import { serve } from 'srvx';
import { createApp, type App } from '../core/app.js';
import { formatConfigErrors, type Env } from '../core/config.js';
import { VERSION } from '../core/version.js';
import { createStaticHandler, findStaticDir } from './static.js';

export interface NodeServerOptions {
  env?: Env;
  port?: number;
  /** Defaults to 0.0.0.0 when the platform sets PORT (PaaS/containers), 127.0.0.1 otherwise. */
  host?: string;
  /** Outbound fetch override (tests). */
  fetch?: typeof fetch;
}

export interface RunningServer {
  url: string;
  app: App;
  close(): Promise<void>;
}

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

/** Standalone HTTP server (Docker, DigitalOcean, Render, Railway, Fly, VPS, local dev). */
export async function startNodeServer(opts: NodeServerOptions = {}): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const port = opts.port ?? Number(env.PORT ?? 3000);
  const host = opts.host ?? env.HOST ?? (env.PORT ? '0.0.0.0' : '127.0.0.1');

  const staticDir = findStaticDir(env.GSCLAW_STATIC_DIR);
  const app = createApp(env, {
    name: 'node',
    localOnly: LOOPBACK.has(host),
    fetch: opts.fetch,
    serveStatic: staticDir ? createStaticHandler(staticDir) : undefined,
  });
  if (app.setupErrors.length > 0) throw new SetupError(formatConfigErrors(app.setupErrors));

  const server = serve({
    fetch: (request) => app.fetch(request),
    port,
    hostname: host,
    silent: true,
    gracefulShutdown: false,
  });
  await server.ready();
  const address = server.node?.server?.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = `http://${displayHost}:${actualPort}`;
  app.runtime?.logger.info('gsclaw listening', { url, version: VERSION, mcp: `${url}/mcp` });

  return {
    url,
    app,
    close: () => server.close(true),
  };
}
