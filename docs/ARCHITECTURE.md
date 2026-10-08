# GSClaw architecture

GSClaw is a Google Search Console MCP server that runs as a hosted HTTPS endpoint (Streamable
HTTP) or as a local stdio process. This document records how it is put together and why.

## Goals

1. **Remote-first.** A stateless HTTP endpoint that works as a custom connector in claude.ai,
   Claude Desktop/mobile and other remote-MCP clients, plus stdio (`npx gsclaw`) for local use.
2. **One-click deploy** to Vercel, Netlify, DigitalOcean, Render, Railway, Cloudflare Workers and
   any Docker host. No database is required anywhere.
3. **Analysis-ready tools** that answer SEO questions directly and return compact, LLM-friendly
   output, not thin API wrappers.

## Layout

```
src/core/            Runtime-agnostic: fetch + WebCrypto only, no node:* imports (enforced by ESLint)
  app.ts             createApp(env, platform) → { fetch(Request) }: the one router every adapter uses
  config.ts          Environment → typed Config; auth-mode detection; setup errors
  runtime.ts         Wires config → token source → GSC client → tool context
  mcp.ts             Builds a per-request McpServer from the tool registry
  gsc/               Search Console REST client (retry/backoff, errors → advice, pagination, cache)
  tools/             One file per tool family: zod input, annotations, run(), format()
  analysis/          Pure functions behind the analysis tools (unit-tested without I/O)
  dates.ts format.ts errors.ts activity.ts ratelimit.ts cache.ts log.ts crypto.ts pages.ts
src/adapters/        Thin entrypoints: node-http (srvx), stdio, vercel, netlify, cloudflare
src/cli.ts           `gsclaw` (stdio, default) | `gsclaw serve` | `gsclaw generate-token`
test/                Vitest unit tests + adapter integration tests against a fake GSC backend
```

## Key decisions

| Decision        | Choice                                                                           | Why                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP SDK         | `@modelcontextprotocol/server` v2                                                | Stable line implementing spec 2026-07-28; only depends on zod; `createMcpHandler()` is a web-standard `fetch` handler that runs on Workers without `nodejs_compat`. |
| Protocol eras   | Modern (2026-07-28) + 2025-era via the SDK's stateless legacy fallback           | claude.ai speaks the 2025 auth/transport specs today; Claude Code negotiates 2026-07-28. Both are served from the same factory.                                     |
| Responses       | `responseMode: 'auto'` (plain JSON unless a tool streams notifications; none do) | Fits Netlify's 60 s limit and every serverless platform; `GET /mcp` → 405.                                                                                          |
| State           | Stateless, per-request server instances                                          | Serverless instances share no memory. Caches, rate limits and the activity log are per instance and documented as such. No KV in v1.                                |
| Google APIs     | Direct `fetch` to REST endpoints; RS256 JWTs signed with WebCrypto               | Small bundles, identical behaviour on Node and Workers; no `googleapis`/`google-auth-library`.                                                                      |
| Tools           | Defined once (`ToolDefinition`), served to MCP and (phase 3) the dashboard API   | The dashboard and the AI always see identical numbers.                                                                                                              |
| Package manager | pnpm 10.x pinned via `packageManager`                                            | Its single-document lockfile is detected natively by every deploy provider (pnpm 11+'s multi-document lockfile trips some).                                         |
| Node            | `>=22`; Docker/CI on Node 24 LTS                                                 | Node 20 is EOL; Node 25+ no longer bundles Corepack.                                                                                                                |
| Layout          | Single package (no workspace)                                                    | Avoids workspace quirks on Vercel; dashboard source will live in `dashboard/` and build into `dist/public`.                                                         |

## Request flow (HTTP)

1. Adapter converts the platform request to a web `Request` and calls `app.fetch`.
2. `Origin` is validated (same origin, `PUBLIC_BASE_URL`, `GSCLAW_ALLOWED_ORIGINS`; loopback when
   bound to localhost, which also enforces the `Host` header against DNS rebinding).
3. Authentication:
   - `Authorization: Bearer <GSCLAW_ACCESS_TOKEN>` on `/mcp` (constant-time comparison), or
   - the secret path `/mcp/<GSCLAW_ACCESS_TOKEN>` for clients that cannot set headers. Wrong
     secrets get **404**, indistinguishable from any unknown URL. `GSCLAW_SECRET_PATH=false`
     disables it.
   - Phase 4 adds a built-in OAuth 2.1 authorization server (DCR + CIMD) for owner sign-in in
     service-account mode and for multi-user Google OAuth mode.
4. Per-token rate limit, body-size cap, then a credential-free copy of the request goes to the SDK
   handler, which builds a fresh `McpServer` with the tools this deployment allows (write tools
   only with `GSCLAW_ALLOW_WRITES=true` and a read/write scope).

## Never run open

A deployment with no auth mode configured refuses to serve: the Node server and stdio exit with a
setup message; serverless adapters answer every route with 503 and a setup page that lists missing
variable **names** (never values).

## Output conventions

- Top N rows (default 25) with an explicit "N more not shown" note and how to get more.
- CTR as a percentage (`ctr_pct`), positions to 1 decimal, integers with separators in text.
- Relative date ranges end on the latest day with **final** data (probed per property and cached);
  `fresh: true` switches to `dataState: "all"`. Dates are Pacific Time.
- Each result carries formatted text plus `structuredContent` with the same (capped) rows.

## Roadmap (not in v1)

Stored rank history, scheduled reports, email/Slack alerts, multi-user admin, and a pluggable KV
backend (persistent activity log, cross-instance rate limits, token revocation).
