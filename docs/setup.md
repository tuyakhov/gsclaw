# Setup guide

This guide takes you from nothing to a working GSClaw deployment connected to your AI assistant.
It takes about 10 minutes.

GSClaw has two authentication modes. Start with the **service account** unless several people
with different Search Console access will use the same deployment; then see
[Google OAuth mode](oauth.md).

|                | Service account                                               | Google OAuth                                       |
| -------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Google account | One service account, shared by everyone you give the token to | Each person signs in with their own Google account |
| Setup          | Create a key, add its email to your properties                | Create an OAuth client and consent screen          |
| Works with     | Every client, including stdio (`npx gsclaw`)                  | Every remote client (HTTP only)                    |

## 1. Enable the Search Console API

1. Open [Google Cloud Console](https://console.cloud.google.com/) and select or create a project.
2. Go to **APIs & Services → Library**, search for **Google Search Console API** and click
   **Enable**.

## 2. Create a service account and key

1. Go to **IAM & Admin → Service accounts → Create service account**. Any name works (for example
   `gsclaw`). It needs **no** Google Cloud roles; skip the optional steps.
2. Open the new service account → **Keys → Add key → Create new key → JSON**. A `.json` file
   downloads. Treat it like a password and never commit it.
3. Note the `client_email` in the file (it looks like
   `gsclaw@your-project.iam.gserviceaccount.com`).

> If key creation is blocked, your organization enforces the
> `iam.disableServiceAccountKeyCreation` policy. Ask an admin for an exception for this project,
> or use [Google OAuth mode](oauth.md) instead.

## 3. Give the service account access in Search Console

For each property you want to use: open [Search Console](https://search.google.com/search-console)
→ select the property → **Settings → Users and permissions → Add user**, enter the service
account's `client_email`, and pick a permission:

- **Restricted** is enough for every read-only tool.
- **Full** is needed only if you enable sitemap submit/delete (`GSCLAW_ALLOW_WRITES=true`).

Domain properties (`sc-domain:example.com`) and URL-prefix properties
(`https://www.example.com/`) are separate: add the user to each one you need.

## 4. Generate an access token

The access token protects your deployment. Clients use it to connect, and you use it to sign in
to the dashboard.

```bash
openssl rand -hex 32
```

(or `npx gsclaw generate-token`). It must be at least 32 characters.

## 5. Deploy

Click a deploy button in the [README](../README.md#get-started) and paste two values when asked:

- `GOOGLE_SERVICE_ACCOUNT_JSON`: the whole contents of the key file. Pasting the raw JSON works
  on every platform; if a form mangles it, paste it base64-encoded instead:
  `base64 < service-account.json | tr -d '\n'`.
- `GSCLAW_ACCESS_TOKEN`: the token from step 4 (Render and Railway generate one for you).

Platform-specific notes (free-tier sleep, timeouts, updating) are in the
[deploy guide](deploy/README.md).

## 6. Check it works

Open `https://<your-deployment>/` and sign in with the access token. **Setup & health** should
show **Connected** and list your properties. If it shows an error, it says what to fix; see also
[troubleshooting](troubleshooting.md).

## 7. Connect your AI

The dashboard's **Connect** page has copy-paste snippets for every client. For claude.ai: Settings
→ Connectors → Add custom connector → paste `https://<your-deployment>/mcp` → Connect, then enter
your access token on the GSClaw page that opens. The connector also appears in Claude Desktop and
the mobile apps.

Try asking: _"Use GSClaw to find striking-distance keywords for my site and suggest which pages to
improve first."_

## Running locally instead

No deployment needed for clients that run local MCP servers (Claude Code, Claude Desktop, Cursor):

```bash
claude mcp add gsclaw -e GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json -- npx -y gsclaw
```

Or run the HTTP server and dashboard on your machine:

```bash
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" GSCLAW_ACCESS_TOKEN="$(npx gsclaw generate-token)" npx gsclaw serve
```

Every setting is documented in [.env.example](../.env.example).

## Rotating secrets

- **Access token:** set a new `GSCLAW_ACCESS_TOKEN` and redeploy. Every client connected with the
  old one (including OAuth sign-ins) and every dashboard session stops working.
- **Service-account key:** create a new key in Google Cloud, update
  `GOOGLE_SERVICE_ACCOUNT_JSON`, redeploy, then delete the old key.
