# Deploying GSClaw on Railway

Railway deploys from a **template**. Railway builds GSClaw from the repository's `Dockerfile`
(it detects it automatically), so no Railway-specific config file is needed. `railway.json`
config-as-code is deprecated for new services.

## Deploy from the template

Click **Deploy on Railway** in the README, fill in `GOOGLE_SERVICE_ACCOUNT_JSON` (the
`GSCLAW_ACCESS_TOKEN` secret is generated for you), and deploy. Then open the service's
**Settings → Networking → Generate Domain** to get a public URL.

## Maintainers: creating the template (one time)

1. In Railway: **Workspace → Templates → New Template**.
2. Add a service from the GitHub repo `tuyakhov/gsclaw` (branch `main`). Railway uses the
   `Dockerfile` at the repo root.
3. Service variables:
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: no default, description "Service-account key JSON (raw or
     base64). See the README quickstart." (required)
   - `GSCLAW_ACCESS_TOKEN`: default `${{ secret(64, "abcdef0123456789") }}` (auto-generated)
4. Service settings: healthcheck path `/healthz`; enable a public domain.
5. Publish (marketplace listing is optional), copy the template code, and replace
   `RAILWAY_TEMPLATE_CODE` in the README's Railway button URL.

## Without a template

Create a new project from the GitHub repo, add the two variables above, set the healthcheck path
to `/healthz`, and generate a domain.
