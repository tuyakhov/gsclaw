import { ActivityLog } from './activity.js';
import type { Config } from './config.js';
import { GscClient, createResponseCache } from './gsc/client.js';
import { SCOPE_READONLY, SCOPE_READWRITE, ServiceAccountTokenSource } from './gsc/auth.js';
import { createLogger, type Logger, type LogWriter } from './log.js';
import { availableTools } from './tools/registry.js';
import type { AnyTool, ToolContext } from './tools/types.js';

export interface RuntimeOptions {
  /** Outbound fetch (tests inject a mock Google API here). */
  fetch?: typeof fetch;
  logWriter?: LogWriter;
  now?: () => Date;
  logFields?: Record<string, unknown>;
}

/** Everything a transport needs to serve tools for one configured deployment. */
export interface Runtime {
  config: Config;
  logger: Logger;
  gsc: GscClient;
  ctx: ToolContext;
  tools: AnyTool[];
  activity: ActivityLog;
}

export function createRuntime(config: Config, opts: RuntimeOptions = {}): Runtime {
  const logger = createLogger({
    level: config.logLevel,
    write: opts.logWriter,
    base: opts.logFields,
  });
  if (config.authMode !== 'service_account' || !config.serviceAccount) {
    throw new Error('Only service-account mode is supported by this runtime.');
  }
  const scopes = [config.allowWrites ? SCOPE_READWRITE : SCOPE_READONLY];
  const tokenSource = new ServiceAccountTokenSource(config.serviceAccount, scopes, {
    fetch: opts.fetch,
  });
  const gsc = new GscClient({
    tokenSource,
    logger,
    fetch: opts.fetch,
    cache: createResponseCache(),
    cacheTtlMs: config.cacheTtlSeconds * 1000,
  });
  const ctx: ToolContext = { gsc, config, logger, now: opts.now ?? (() => new Date()) };
  return {
    config,
    logger,
    gsc,
    ctx,
    tools: availableTools({ allowWrites: config.allowWrites, canWrite: gsc.canWrite }),
    activity: new ActivityLog(),
  };
}
