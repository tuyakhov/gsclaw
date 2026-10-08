# GSClaw

> Sink your claws into your Search Console data.

GSClaw is an open-source MCP server that gives AI assistants (Claude, Claude Code, Cursor,
ChatGPT, VS Code and more) first-party access to Google Search Console. It runs as a hosted
HTTPS endpoint (Streamable HTTP) or locally over stdio, and ships analysis tools like
striking-distance keywords, CTR gaps, cannibalization and period comparison.

> **Status:** early development. Service-account mode works on every target below; the
> dashboard and Google OAuth (multi-user) mode are on the way. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

GSClaw is independent and not affiliated with Google or OpenClaw.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](<https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ftuyakhov%2Fgsclaw&env=GOOGLE_SERVICE_ACCOUNT_JSON,GSCLAW_ACCESS_TOKEN&envDescription=Service-account%20key%20JSON%20and%20a%20long%20random%20access%20token%20(openssl%20rand%20-hex%2032)&envLink=https%3A%2F%2Fgithub.com%2Ftuyakhov%2Fgsclaw%23quickstart-local&project-name=gsclaw&repository-name=gsclaw>)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/tuyakhov/gsclaw)
[![Deploy to DigitalOcean](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/tuyakhov/gsclaw/tree/main)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tuyakhov/gsclaw)
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/gsclaw?utm_medium=integration&utm_source=button&utm_campaign=gsclaw)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tuyakhov/gsclaw)

Every target asks for two values: `GOOGLE_SERVICE_ACCOUNT_JSON` (your service-account key) and
`GSCLAW_ACCESS_TOKEN` (a long random secret; Render and Railway generate it for you). Your MCP
endpoint is `https://<your-deployment>/mcp`.

**Docker** (Fly.io, Coolify, any VPS):

```bash
docker run -p 3000:3000 -e GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" -e GSCLAW_ACCESS_TOKEN="$(openssl rand -hex 32)" ghcr.io/tuyakhov/gsclaw
```

Fly.io: see [deploy/fly.toml](deploy/fly.toml).

## Quickstart (local)

1. In Google Cloud, enable the **Google Search Console API**, create a service account and
   download a JSON key.
2. In Search Console, add the service account's `client_email` as a user on each property
   (Settings → Users and permissions → Add user; Restricted is enough for reading).
3. Run it:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" GSCLAW_ACCESS_TOKEN="$(npx gsclaw generate-token)" npx gsclaw serve
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` (send `Authorization: Bearer <token>`).

For stdio clients such as Claude Code:

```bash
claude mcp add gsclaw -e GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json -- npx -y gsclaw
```

## Tools

| Tool                                 | What it does                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `list_sites`                         | Properties the server can access, with permission levels                                    |
| `search_analytics`                   | Raw performance query: any dimensions, filters (incl. regex), search types, auto-pagination |
| `compare_periods`                    | Current vs previous period or year over year, with top gainers and losers                   |
| `striking_distance_keywords`         | Queries at positions ~8–20 with meaningful impressions, plus potential clicks               |
| `ctr_opportunities`                  | High-impression rows with CTR well below the expected CTR for their position                |
| `keyword_cannibalization`            | Queries where several of your pages split impressions                                       |
| `content_decay`                      | Pages with sustained click decline across consecutive windows                               |
| `page_report`                        | One page: totals vs previous period, trend, top queries and index status                    |
| `inspect_url` / `batch_inspect_urls` | URL Inspection: index status, canonicals, last crawl, rich results                          |
| `list_sitemaps` / `get_sitemap`      | Sitemap status, errors, warnings and submitted counts                                       |
| `submit_sitemap` / `delete_sitemap`  | Write tools, only when `GSCLAW_ALLOW_WRITES=true`                                           |

Prompt: `seo_health_check` runs a full property review with these tools.

## Development

Requires Node 22+ and pnpm (via Corepack: `corepack enable`).

```bash
pnpm install
pnpm dev          # HTTP server with reload (reads env from your shell)
pnpm test         # unit + adapter integration tests (no Google calls)
pnpm lint && pnpm typecheck && pnpm build
```

Test with the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):
`pnpm inspector`, then connect to `http://127.0.0.1:3000/mcp` with the bearer token.

All configuration is documented in [.env.example](.env.example).

## License

[MIT](LICENSE)
