#!/usr/bin/env node
import { SetupError, startNodeServer } from './adapters/node-http.js';
import { runStdio } from './adapters/stdio.js';
import { randomToken } from './core/crypto.js';
import { REPO_URL, VERSION } from './core/version.js';

const HELP = `GSClaw ${VERSION} — Google Search Console MCP server

Usage:
  gsclaw                     Run as a local stdio MCP server (default)
  gsclaw serve [options]     Run the HTTP server (Streamable HTTP at /mcp)
  gsclaw generate-token      Print a random secret (GSCLAW_ACCESS_TOKEN, GSCLAW_ENCRYPTION_KEY)
  gsclaw --version | --help

Serve options:
  --port <n>                 Port (default: $PORT or 3000)
  --host <addr>              Bind address (default: 0.0.0.0 if $PORT is set, else 127.0.0.1)

Environment (service-account mode):
  GOOGLE_SERVICE_ACCOUNT_JSON     Service-account key JSON (raw or base64)
  GOOGLE_APPLICATION_CREDENTIALS  Path to the key file (stdio only, alternative to the above)
  GSCLAW_ACCESS_TOKEN             Secret clients must present (HTTP only)

Environment (Google OAuth mode, HTTP only):
  GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GSCLAW_ENCRYPTION_KEY, PUBLIC_BASE_URL
  ALLOWED_GOOGLE_DOMAINS, ALLOWED_GOOGLE_EMAILS   Who may sign in (default: anyone)

  GSCLAW_ALLOW_WRITES=true        Enable submit_sitemap / delete_sitemap

All settings: ${REPO_URL}/blob/main/.env.example
Docs: ${REPO_URL}#readme`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (command === '--version' || command === '-v') return void console.log(VERSION);
  if (command === '--help' || command === '-h' || command === 'help') return void console.log(HELP);
  if (command === 'generate-token') return void console.log(randomToken(32));

  if (command === 'serve') {
    const port = option(rest, '--port');
    const server = await startNodeServer({
      port: port ? Number(port) : undefined,
      host: option(rest, '--host'),
    });
    const shutdown = () => {
      void server.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }

  if (command === undefined || command === 'stdio') return runStdio();

  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof SetupError) console.error(error.message);
  else console.error(error);
  process.exit(1);
});
