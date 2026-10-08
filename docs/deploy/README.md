# Deploy guide

Every target runs the same code and needs no database. Each one asks for
`GOOGLE_SERVICE_ACCOUNT_JSON` and `GSCLAW_ACCESS_TOKEN` (see the [setup guide](../setup.md)); for
multi-user sign-in, set the [Google OAuth](../oauth.md) variables instead. Your MCP endpoint is
always `https://<your-deployment>/mcp`, and the dashboard is at `/`.

| Platform                          | Cost to start     | Cold starts                  | Public URL auto-detected |
| --------------------------------- | ----------------- | ---------------------------- | ------------------------ |
| [Vercel](#vercel)                 | Free (Hobby)      | Short                        | Yes                      |
| [Netlify](#netlify)               | Free              | Short                        | Yes                      |
| [Cloudflare Workers](#cloudflare) | Free              | None                         | No                       |
| [Render](#render)                 | Free (sleeps)     | ~30–60 s after idle on free  | Yes                      |
| [Railway](#railway)               | Usage-based       | None                         | Yes                      |
| [DigitalOcean](#digitalocean)     | Small monthly fee | None                         | Yes                      |
| [Docker / VPS / Fly.io](#docker)  | Your server       | None (Fly: on first request) | Fly only                 |

"Public URL auto-detected" means you only need to set `PUBLIC_BASE_URL` on the others when you use
Google OAuth mode or a custom domain behind a proxy.

## Keeping it up to date

The dashboard's **Setup & health** page tells you when a new version is out.

- **Vercel, Netlify, Cloudflare, Render, DigitalOcean** deploy from a copy of this repository in
  your GitHub account. Pull the latest `main` from `tuyakhov/gsclaw` into your copy (GitHub's
  **Sync fork** if it is a fork, or `git pull https://github.com/tuyakhov/gsclaw main`), then
  redeploy if the platform doesn't do it automatically.
- **Railway:** redeploy the service; if Railway created a copy of the repository in your GitHub
  account, sync it first.
- **Docker / Fly.io:** pull the new image (`ghcr.io/tuyakhov/gsclaw:latest`, or pin a version tag
  such as `:0.1.0`) and restart.

## Vercel

The button copies the repository into your GitHub account, asks for both variables and deploys. GSClaw runs as one Vercel
Function (Fluid compute) with a 300 s limit; the dashboard's assets are served from Vercel's CDN.

- The production domain is detected automatically. Preview deployments get other URLs, so Google
  OAuth sign-in only works on the production domain (or add each preview URL as a redirect URI).
- If `/mcp` answers with a Vercel login page, **Deployment Protection** covers that URL. Turn it
  off for the domain your AI connects to (Project → Settings → Deployment Protection).

## Netlify

The button copies the repository into your GitHub account, asks for both variables and deploys.
GSClaw runs as a Netlify
Function; the dashboard's assets are served from Netlify's CDN. Netlify Functions stop after 60
seconds, which is plenty for GSClaw's tools.

## Cloudflare

The button copies the repository into your GitHub account, builds it and deploys with `wrangler`,
asking for the secrets
listed in `.dev.vars.example`. To deploy from your own checkout instead:

```bash
pnpm install && pnpm build
pnpm exec wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON
pnpm exec wrangler secret put GSCLAW_ACCESS_TOKEN
pnpm exec wrangler deploy
```

- Set `PUBLIC_BASE_URL` (as a variable or secret) for Google OAuth mode; Workers don't expose
  their public URL to code.
- The Workers Free plan limits CPU time per request. Large analyses over long date ranges can hit
  it; the Paid plan's limits are far higher.

## Render

The button creates a web service from `render.yaml`, generates `GSCLAW_ACCESS_TOKEN` (find it under
**Environment**) and asks for the service-account key. Free services sleep after 15 minutes
without traffic and take a while to wake, which can make the first request from your AI time out;
retry, or use a paid instance. Auto-deploy is off: click **Manual Deploy** to update.

## Railway

Use the [GSClaw template](https://railway.com/deploy/gsclaw). See [railway.md](railway.md) for
details, including finding the generated token and domain.

## DigitalOcean

The button creates an App Platform app that builds the repository's `Dockerfile` on the smallest
instance size. Enter both variables as encrypted secrets when asked.

## Docker

The image is published for `linux/amd64` and `linux/arm64`:

```bash
docker run -d --name gsclaw -p 3000:3000 --restart unless-stopped \
  -e GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
  -e GSCLAW_ACCESS_TOKEN="$(openssl rand -hex 32)" \
  ghcr.io/tuyakhov/gsclaw
```

Or with Compose:

```yaml
services:
  gsclaw:
    image: ghcr.io/tuyakhov/gsclaw:latest
    restart: unless-stopped
    ports: ['3000:3000']
    env_file: .env # GOOGLE_SERVICE_ACCOUNT_JSON, GSCLAW_ACCESS_TOKEN, PUBLIC_BASE_URL, ...
```

AI clients need HTTPS, so put it behind a reverse proxy that terminates TLS (Caddy, Traefik,
nginx, Coolify) and set `PUBLIC_BASE_URL=https://your-domain`. The container runs as a non-root
user and has a health check on `/healthz`.

### Fly.io

`deploy/fly.toml` deploys the published image:

```bash
fly launch --config deploy/fly.toml --copy-config --no-deploy
fly secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" GSCLAW_ACCESS_TOKEN="$(openssl rand -hex 32)"
fly deploy --config deploy/fly.toml
```

Machines stop when idle and start on the next request.

## Per-instance state

Serverless platforms run several short-lived instances. GSClaw keeps its response cache, rate
limits and the dashboard's activity log in memory, per instance, so the activity log shows recent
calls handled by the instance that serves the dashboard, not a complete history. Nothing else
depends on instance state: tokens and sessions work on every instance.
