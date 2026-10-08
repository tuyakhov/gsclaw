import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { formatConfigErrors, loadConfig, type Env } from '../core/config.js';
import { stderrWriter } from '../core/log.js';
import { buildMcpServer } from '../core/mcp.js';
import { createRuntime } from '../core/runtime.js';
import { SetupError } from './node-http.js';

/**
 * Local stdio server for Claude Code, Cursor, Claude Desktop, etc. No access token is needed: the
 * client launches this process itself. The key can also come from a file via
 * GOOGLE_APPLICATION_CREDENTIALS.
 */
export async function runStdio(opts: { env?: Env; fetch?: typeof fetch } = {}): Promise<void> {
  const env = { ...(opts.env ?? process.env) };
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON && env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      env.GOOGLE_SERVICE_ACCOUNT_JSON = readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    } catch (error) {
      throw new SetupError(
        `Could not read GOOGLE_APPLICATION_CREDENTIALS (${env.GOOGLE_APPLICATION_CREDENTIALS}): ${(error as Error).message}`,
      );
    }
  }

  const loaded = loadConfig(env, { transport: 'stdio' });
  if (!loaded.ok) throw new SetupError(formatConfigErrors(loaded.errors));

  // stdout carries the protocol; logs must go to stderr.
  const runtime = createRuntime(loaded.config, {
    fetch: opts.fetch,
    logWriter: stderrWriter,
    logFields: { transport: 'stdio' },
  });
  for (const warning of loaded.warnings) runtime.logger.warn(warning);

  serveStdio(() =>
    buildMcpServer({
      tools: runtime.tools,
      ctx: runtime.ctx,
      logger: runtime.logger,
      activity: runtime.activity,
      client: 'stdio',
    }),
  );
}
