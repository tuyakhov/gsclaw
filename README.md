# GSClaw

> Sink your claws into your Search Console data.

GSClaw is an open-source MCP server that gives AI assistants (Claude, Claude Code, Cursor,
ChatGPT, VS Code and more) first-party access to Google Search Console. It runs as a hosted
HTTPS endpoint (Streamable HTTP) or locally over stdio, and ships analysis tools like
striking-distance keywords, CTR gaps, cannibalization and period comparison.

> **Status:** early development (0.x). Both authentication modes and the dashboard work on every
> target below. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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
endpoint is `https://<your-deployment>/mcp`. To let each person sign in with their own Google
account instead, set the [Google OAuth mode](#google-oauth-mode) variables.

No database is needed in either mode: GSClaw is stateless and stores nothing.

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

## Authentication modes

GSClaw never runs open: it refuses to start until one of these modes is configured.

|                      | Service account (default)                                         | Google OAuth                                                                                       |
| -------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Who sees what        | Everyone with access sees the service account's properties        | Each person sees the properties their own Google account can access                                |
| Clients authenticate | OAuth sign-in with the access token, bearer header, or secret URL | OAuth sign-in with Google                                                                          |
| Best for             | You, or a team sharing the same properties                        | Agencies and teams where people have different access                                              |
| Required variables   | `GOOGLE_SERVICE_ACCOUNT_JSON`, `GSCLAW_ACCESS_TOKEN`              | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GSCLAW_ENCRYPTION_KEY`, `PUBLIC_BASE_URL` |

### Google OAuth mode

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the
   **Google Search Console API** for your project.
2. Configure the **OAuth consent screen** (Google Auth Platform): choose **Internal** if everyone
   is in your Google Workspace, otherwise **External**. Add the scopes `openid`, `email` and
   `https://www.googleapis.com/auth/webmasters.readonly` (or `.../auth/webmasters` if you enable
   writes).
3. Create an **OAuth client ID** of type **Web application** with the authorized redirect URI
   `https://<your-deployment>/oauth/google/callback`.
4. Set these variables on your deployment and redeploy:

   ```bash
   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=...
   GSCLAW_ENCRYPTION_KEY=$(openssl rand -hex 32)
   PUBLIC_BASE_URL=https://<your-deployment>   # auto-detected on Vercel, Netlify, Render, Railway, DigitalOcean, Fly
   ALLOWED_GOOGLE_DOMAINS=example.com          # and/or ALLOWED_GOOGLE_EMAILS; empty = any Google account
   ```

   Remove `GOOGLE_SERVICE_ACCOUNT_JSON` and `GSCLAW_ACCESS_TOKEN`, or set
   `GSCLAW_AUTH_MODE=oauth`.

Good to know:

- Search Console scopes are **sensitive**. An External app in _Testing_ status works for up to
  100 test users you list, but Google expires their sign-in after 7 days. For long-lived access,
  publish the app (Google may require verification) or use an Internal app.
- Allowlists only decide who may sign in; data access always follows each person's own Search
  Console permissions.
- Users can revoke access at any time under Google Account → Security → Third-party connections.
  Changing `GSCLAW_ENCRYPTION_KEY` signs everyone out.

## Connect your AI

The dashboard's **Connect** page has copy-paste snippets for every client. In short:

- **claude.ai, Claude Desktop & mobile:** Settings → Connectors → Add custom connector → paste
  `https://<your-deployment>/mcp` → Connect. GSClaw opens a sign-in page: enter your access token
  (service-account mode) or sign in with Google (OAuth mode).
- **Claude Code:** `claude mcp add --transport http gsclaw https://<your-deployment>/mcp`, then
  run `/mcp` to sign in. In service-account mode you can instead add
  `--header "Authorization: Bearer <token>"`.
- **Cursor, VS Code, ChatGPT:** add the same URL; they sign in the same way.

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

## Dashboard

Every deployment also serves a small dashboard at `/` (sign in with your `GSCLAW_ACCESS_TOKEN`,
or with Google in OAuth mode, where everyone sees only their own properties and activity):

- **Setup & health**: live Google API check, the service-account email to add in Search Console
  (or the OAuth redirect URI and who can sign in), visible properties with permission levels,
  server version and update notice.
- **Connect**: copy-paste snippets for claude.ai, Claude Code, Cursor, VS Code, ChatGPT and stdio,
  with secrets hidden until revealed.
- **Overview**: clicks, impressions, CTR and position with deltas, a trend chart, top queries
  and pages.
- **Opportunities**: striking-distance keywords, CTR gaps, cannibalization and content decay, each
  row with an "Ask AI" button that copies a ready-made prompt.
- **Indexing**: sitemap health and URL Inspection.
- **Activity**: recent MCP tool calls (metadata only), so you can see what your AI is doing.

The dashboard calls the exact same tool functions as the MCP server, so its numbers always match
what your AI sees. Every table exports to CSV. Turn it off with `GSCLAW_DASHBOARD=false`.

## Development

Requires Node 22+ and pnpm (via Corepack: `corepack enable`).

```bash
pnpm install
pnpm build && pnpm demo   # server + dashboard on fake Search Console data (no Google account)
DEMO_AUTH=oauth pnpm demo # the same in Google OAuth mode, with a stand-in Google sign-in page
pnpm dev          # HTTP server with reload (reads env from your shell)
pnpm dev:dashboard        # rebuild the dashboard bundle on change
pnpm test         # unit + adapter integration tests (no Google calls)
pnpm lint && pnpm typecheck && pnpm build
```

Test with the [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector):
`pnpm inspector`, then connect to `http://127.0.0.1:3000/mcp` with the bearer token.

All configuration is documented in [.env.example](.env.example).

## License

[MIT](LICENSE)
