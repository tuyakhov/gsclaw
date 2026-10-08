# Google OAuth mode

In Google OAuth mode every person signs in with their own Google account, and GSClaw calls Search
Console with that person's credentials. Nobody sees a property their own account can't access.
Use it for agencies, teams with different access, or when you can't create service-account keys.

OAuth mode is for HTTP deployments. For local stdio use, see [service-account setup](setup.md).

## 1. Enable the Search Console API

In [Google Cloud Console](https://console.cloud.google.com/), select or create a project, then
**APIs & Services → Library → Google Search Console API → Enable**.

## 2. Configure the consent screen

Go to **Google Auth Platform** (APIs & Services → OAuth consent screen):

1. **Branding:** an app name your users will recognize (for example "GSClaw"), a support email,
   and your deployment's domain under authorized domains.
2. **Audience:**
   - **Internal** if everyone who will sign in is in your Google Workspace organization. No
     verification is needed and sign-ins don't expire.
   - **External** otherwise. While the app is in **Testing**, only the test users you list (up to 100) can sign in, and Google expires their sign-in after 7 days. **Publish** the app to lift
     both limits; Google may ask you to verify it because Search Console scopes are classified as
     sensitive.
3. **Data access:** add the scopes `openid`, `.../auth/userinfo.email` and
   `https://www.googleapis.com/auth/webmasters.readonly`. If you enable writes
   (`GSCLAW_ALLOW_WRITES=true`), add `https://www.googleapis.com/auth/webmasters` instead of the
   read-only scope.

## 3. Create the OAuth client

**Google Auth Platform → Clients → Create client**, type **Web application**. Under **Authorized
redirect URIs** add:

```
https://<your-deployment>/oauth/google/callback
```

It must match `PUBLIC_BASE_URL` exactly (scheme, host, no trailing slash). If you use both a
platform domain and a custom domain, add one URI per domain and set `PUBLIC_BASE_URL` to the one
people use. Copy the **client ID** and **client secret**.

## 4. Configure GSClaw

Set these variables on your deployment and redeploy:

| Variable                     | Value                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_OAUTH_CLIENT_ID`     | From step 3 (ends in `.apps.googleusercontent.com`)                                                                                        |
| `GOOGLE_OAUTH_CLIENT_SECRET` | From step 3                                                                                                                                |
| `GSCLAW_ENCRYPTION_KEY`      | `openssl rand -hex 32`. Encrypts every token GSClaw issues                                                                                 |
| `PUBLIC_BASE_URL`            | `https://<your-deployment>`. Auto-detected on Vercel, Netlify, Render, Railway, DigitalOcean and Fly.io; required on Cloudflare and Docker |
| `ALLOWED_GOOGLE_DOMAINS`     | Optional, comma-separated, e.g. `example.com`                                                                                              |
| `ALLOWED_GOOGLE_EMAILS`      | Optional, comma-separated, e.g. `alice@example.com,bob@gmail.com`                                                                          |

If the deployment was in service-account mode, remove `GOOGLE_SERVICE_ACCOUNT_JSON` and
`GSCLAW_ACCESS_TOKEN`, or set `GSCLAW_AUTH_MODE=oauth`. GSClaw refuses to start if the settings
are incomplete and lists what's missing (names only, never values).

With no allowlist, anyone with a Google account can sign in. They still only see their own
properties, but they do use your deployment, so set an allowlist unless that's what you want.

## 5. Sign in and connect

- **Dashboard:** open `https://<your-deployment>/` and click **Sign in with Google**. **Setup &
  health** shows the redirect URI GSClaw expects and who can sign in.
- **claude.ai, Claude Desktop & mobile:** Settings → Connectors → Add custom connector → paste
  `https://<your-deployment>/mcp` → Connect, then sign in with Google.
- **Claude Code:** `claude mcp add --transport http gsclaw https://<your-deployment>/mcp`, then
  run `/mcp` and choose GSClaw to sign in.
- **Cursor, VS Code, ChatGPT:** add the same URL as a remote MCP server; each asks you to sign
  in.

## How it works

GSClaw acts as an OAuth 2.1 authorization server for your AI clients and as an OAuth client of
Google. When a client connects, GSClaw shows a consent page naming the client, sends you to
Google, checks the allowlist and that Search Console access was granted, and gives the client its
own GSClaw token. That token contains your Google tokens, encrypted with `GSCLAW_ENCRYPTION_KEY`;
GSClaw itself stores nothing. Details: [ARCHITECTURE.md](ARCHITECTURE.md#oauth),
[SECURITY.md](../SECURITY.md).

## Revoking access

- **One person, everywhere:** they remove GSClaw under Google Account → Security → Third-party
  connections. Their GSClaw tokens stop working immediately.
- **One client:** disconnect it in the client (for example, remove the connector in claude.ai).
- **Everyone:** change `GSCLAW_ENCRYPTION_KEY` and redeploy. Everyone has to sign in again.
- **Remove someone from the allowlist** and redeploy: their existing connections and dashboard
  session stop working too, because the allowlist is checked on every request.
