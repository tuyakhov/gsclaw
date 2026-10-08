# Troubleshooting

Start with the dashboard's **Setup & health** page: it calls Google live and explains what's
wrong. Tool errors your AI receives carry the same advice.

## The deployment shows "GSClaw needs configuration"

GSClaw refuses to run until an authentication mode is fully configured. The page lists the
missing or invalid variables (names only, never their values). Set them in your hosting dashboard
and redeploy. Common causes:

- `GSCLAW_ACCESS_TOKEN` shorter than 32 characters. Generate one with `openssl rand -hex 32`.
- `GOOGLE_SERVICE_ACCOUNT_JSON` truncated by a form field. Paste it base64-encoded instead:
  `base64 < service-account.json | tr -d '\n'`.
- An OAuth client JSON file pasted into `GOOGLE_SERVICE_ACCOUNT_JSON`. Service-account keys have
  `"type": "service_account"`; OAuth clients belong in `GOOGLE_OAUTH_CLIENT_ID`/`SECRET`.
- Variables for both modes set at once. Remove one set, or set `GSCLAW_AUTH_MODE`.

## Google errors

| What you see                                      | Fix                                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| "The Google Search Console API is not enabled"    | Enable it for the project that owns the key or OAuth client (the message links to it), wait a minute, retry.                             |
| "… does not have access to …" (HTTP 403)          | Add the service-account email (or ask a property owner to add your Google account) in Search Console → Settings → Users and permissions. |
| A property is missing from `list_sites`           | Same as above. Domain (`sc-domain:example.com`) and URL-prefix (`https://www.example.com/`) properties are separate.                     |
| "Unverified (no data)" next to a property         | The property was added but never verified for this account. Verify it in Search Console.                                                 |
| "Google rejected the service-account credentials" | The key was deleted or rotated. Create a new JSON key and update `GOOGLE_SERVICE_ACCOUNT_JSON`.                                          |
| Rate-limit or quota errors                        | Wait and retry. URL Inspection allows 2,000 inspections per property per day (resets at midnight Pacific).                               |
| Key creation blocked in Google Cloud              | Your organization enforces `iam.disableServiceAccountKeyCreation`. Ask an admin for an exception, or use [Google OAuth mode](oauth.md).  |

## Numbers don't match the Search Console UI

- GSClaw uses **final** data only by default, so the most recent 2–3 days are excluded. Pass
  `fresh: true` to a tool to include preliminary data.
- Totals by query or page are lower than property totals: Google hides anonymized queries and
  limits row counts. That's how the API works, in every tool.
- Dates are Pacific Time, like Search Console.

## Connecting AI clients

- **claude.ai says it couldn't connect.** The URL must be HTTPS and end in `/mcp`. Open
  `https://<your-deployment>/.well-known/oauth-protected-resource/mcp` in a browser: its `resource`
  must equal the URL you pasted. If it shows a different host, set `PUBLIC_BASE_URL`.
- **Vercel shows a login page instead of GSClaw.** Turn off Deployment Protection for that domain
  (see the [deploy guide](deploy/README.md#vercel)).
- **The sign-in page says the access token is not correct.** Use the current `GSCLAW_ACCESS_TOKEN`;
  after several wrong attempts, wait a minute.
- **A client stopped working after a redeploy.** Changing `GSCLAW_ACCESS_TOKEN` or
  `GSCLAW_ENCRYPTION_KEY` disconnects every client. Reconnect them.
- **The first request times out on Render's free plan.** The service was asleep; retry.
- **`401` with a bearer token.** The token doesn't match `GSCLAW_ACCESS_TOKEN` (watch for spaces
  or a trailing newline), or the deployment is in Google OAuth mode, which only accepts sign-in.
- **`404` on `/mcp/<token>`.** The token in the path is wrong, the secret path is disabled
  (`GSCLAW_SECRET_PATH=false`), or the deployment is in Google OAuth mode.

## Google OAuth mode

| What you see                                                                  | Fix                                                                                                                                      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Google: `redirect_uri_mismatch`                                               | Add exactly `PUBLIC_BASE_URL` + `/oauth/google/callback` to the OAuth client's authorized redirect URIs. Setup & health shows the value. |
| Google: "Access blocked: … has not completed the Google verification process" | The app is in Testing and this account isn't a test user. Add it under Audience → Test users, or publish the app.                        |
| Google: "Google hasn't verified this app"                                     | Expected for unverified External apps. Test users can continue via **Advanced**; verify the app for everyone else.                       |
| "This Google account isn't allowed to use this deployment"                    | The account doesn't match `ALLOWED_GOOGLE_EMAILS` / `ALLOWED_GOOGLE_DOMAINS`.                                                            |
| "Search Console access was not granted"                                       | The person unticked the Search Console permission on Google's consent screen. Sign in again and keep it ticked.                          |
| "Sign-in expired or was started in a different browser"                       | Start again and finish in the same browser within 15 minutes. Blocking cookies for the deployment's domain also causes this.             |
| Everyone has to sign in again every 7 days                                    | The app is External and in Testing. Publish it, or use an Internal app.                                                                  |

## Still stuck?

[Open an issue](https://github.com/tuyakhov/gsclaw/issues/new/choose) with the GSClaw version
(shown in Setup & health), the platform and the exact error. Never include keys, tokens or the
contents of `GOOGLE_SERVICE_ACCOUNT_JSON`. Report security problems privately as described in
[SECURITY.md](../SECURITY.md).
