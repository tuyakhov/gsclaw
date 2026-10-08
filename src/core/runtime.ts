import { ActivityLog } from './activity.js';
import type { Config } from './config.js';
import { GscClient, createResponseCache } from './gsc/client.js';
import {
  SCOPE_READONLY,
  SCOPE_READWRITE,
  ServiceAccountTokenSource,
  UserTokenSource,
  type UserTokenCache,
} from './gsc/auth.js';
import { createLogger, type Logger, type LogWriter } from './log.js';
import { refreshGoogleToken } from './oauth/google.js';
import { SCOPE_WRITE, type Principal } from './principal.js';
import { availableTools } from './tools/registry.js';
import type { AnyTool, ToolContext } from './tools/types.js';

export interface RuntimeOptions {
  /** Outbound fetch (tests inject a mock Google API here). */
  fetch?: typeof fetch;
  logWriter?: LogWriter;
  now?: () => Date;
  logFields?: Record<string, unknown>;
}

/** What one caller can do: a Search Console client for their identity and the tools they may use. */
export interface Session {
  gsc: GscClient;
  ctx: ToolContext;
  tools: AnyTool[];
}

/** Everything a transport needs to serve tools for one configured deployment. */
export interface Runtime {
  config: Config;
  logger: Logger;
  activity: ActivityLog;
  /** Service-account mode: the deployment owner's session (also used by stdio). */
  owner?: Session;
  /** The session for an authenticated caller. */
  sessionFor(principal: Principal): Session;
}

export function createRuntime(config: Config, opts: RuntimeOptions = {}): Runtime {
  const logger = createLogger({
    level: config.logLevel,
    write: opts.logWriter,
    base: opts.logFields,
  });
  const now = opts.now ?? (() => new Date());
  const cache = createResponseCache();
  const userTokens: UserTokenCache = new Map();

  const sessionWith = (gsc: GscClient, principal?: Principal): Session => {
    const canWrite = gsc.canWrite && (!principal || principal.scopes.includes(SCOPE_WRITE));
    return {
      gsc,
      ctx: { gsc, config, logger, now },
      tools: availableTools({ allowWrites: config.allowWrites, canWrite }),
    };
  };

  let owner: Session | undefined;
  if (config.authMode === 'service_account') {
    if (!config.serviceAccount)
      throw new Error('Service-account mode requires a service account key.');
    const scopes = [config.allowWrites ? SCOPE_READWRITE : SCOPE_READONLY];
    const tokenSource = new ServiceAccountTokenSource(config.serviceAccount, scopes, {
      fetch: opts.fetch,
    });
    owner = sessionWith(
      new GscClient({
        tokenSource,
        logger,
        fetch: opts.fetch,
        cache,
        cacheTtlMs: config.cacheTtlSeconds * 1000,
      }),
    );
  }

  return {
    config,
    logger,
    activity: new ActivityLog(),
    owner,
    sessionFor(principal) {
      if (config.authMode === 'service_account') return sessionWith(owner!.gsc, principal);

      const google = principal.google;
      const oauth = config.googleOAuth;
      if (principal.kind !== 'user' || !google || !principal.email || !oauth) {
        throw new Error('OAuth mode requires a signed-in Google user.');
      }
      const tokenSource = new UserTokenSource(principal.email, google.scope, {
        sub: principal.sub,
        accessToken: google.accessToken,
        expiresAt: google.expiresAt,
        refreshToken: google.refreshToken,
        cache: userTokens,
        now: () => now().getTime(),
        refresh: async (refreshToken) => {
          const fresh = await refreshGoogleToken(oauth, {
            refreshToken,
            fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
            nowSeconds: Math.floor(now().getTime() / 1000),
          });
          return { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
        },
      });
      return sessionWith(
        new GscClient({
          tokenSource,
          logger,
          fetch: opts.fetch,
          cache,
          cacheTtlMs: config.cacheTtlSeconds * 1000,
        }),
        principal,
      );
    },
  };
}
