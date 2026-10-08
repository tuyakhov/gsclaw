# Deploying GSClaw on Railway

Railway deploys from a **template**. Railway builds GSClaw from the repository's `Dockerfile`
(it detects it automatically), so no Railway-specific config file is needed. `railway.json`
config-as-code is deprecated for new services.

## Deploy from the template

Open the [GSClaw template](https://railway.com/deploy/gsclaw) (or click **Deploy on Railway** in
the README), paste your key into `GOOGLE_SERVICE_ACCOUNT_JSON` (`GSCLAW_ACCESS_TOKEN` is generated
for you), and deploy. Railway generates a public domain on deploy; find it under the service's
**Settings → Networking**. Your MCP endpoint is `https://YOUR_DOMAIN/mcp`, and the token is in the
service's **Variables** tab.

## Maintainers: creating the template (one time)

1. In Railway: **Workspace → Templates → New Template**.
2. Add a service from the GitHub repo `tuyakhov/gsclaw` (branch `main`). Railway uses the
   `Dockerfile` at the repo root.
3. Service variables:
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: no default, description "Service-account key JSON (raw or
     base64). See the README quickstart." (required)
   - `GSCLAW_ACCESS_TOKEN`: default `${{ secret(64, "abcdef0123456789") }}` (auto-generated)
   - `PORT`: `3000` (pins the port so it always matches the HTTP proxy below)
4. Service settings:
   - Networking → **Add HTTP Proxy** with port `3000` (this creates the public domain). Do not add
     a TCP proxy; GSClaw only serves HTTP.
   - Root directory, pre-deploy command and custom start command: leave empty (the Dockerfile's
     `CMD` runs `node dist/cli.js serve`).
   - Healthcheck path: `/healthz`.
5. Publish. The marketplace listing lives at https://railway.com/deploy/gsclaw, which the
   README's Railway button links to. Listing copy: [railway-listing.md](railway-listing.md).

## Without a template

Create a new project from the GitHub repo, add the two variables above, set the healthcheck path
to `/healthz`, and generate a domain.
