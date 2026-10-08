# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: open the repository's **Security** tab →
**Report a vulnerability** (<https://github.com/tuyakhov/gsclaw/security/advisories/new>).
Include the affected version, a description, and steps to reproduce if you can.

You can expect an acknowledgement within 5 business days. Confirmed issues are fixed in a
patch release and credited in the advisory unless you prefer to stay anonymous.

## Supported versions

Security fixes go into the latest minor release.

## Deployment security model (summary)

- GSClaw refuses to start unless an authentication mode is configured; it never runs open.
- Service-account mode: clients sign in through GSClaw's OAuth flow (the owner approves by
  entering `GSCLAW_ACCESS_TOKEN`), or present the token as a bearer header or in the secret path
  `/mcp/<token>`. Comparisons are constant-time; wrong secret paths return 404 and consent-page
  attempts are rate-limited. Secret paths can appear in hosting providers' request logs, so prefer
  OAuth or the bearer header, and disable the secret path with `GSCLAW_SECRET_PATH=false` if you
  don't need it. Rotating the token revokes every credential issued with it.
- Google OAuth mode: each person signs in with Google and GSClaw calls Search Console with their
  own credentials, so nobody sees more than their Google account can. Optional email/domain
  allowlists (`ALLOWED_GOOGLE_EMAILS`, `ALLOWED_GOOGLE_DOMAINS`) require a Google-verified email
  and are checked on every request, so removing someone takes effect as soon as you redeploy.
- Built-in OAuth 2.1 authorization server: public clients only, PKCE (S256) required, redirect
  URIs limited to loopback and known MCP clients unless `GSCLAW_OAUTH_REDIRECT_HOSTS` adds more,
  access tokens bound to this deployment's `/mcp` resource (RFC 8707) and valid for at most an
  hour, refresh tokens rotated on use. The Google sign-in round-trip is bound to the browser that
  started it (HttpOnly state cookie), and consent pages name the client and where it redirects.
- Stateless by design: GSClaw has no database. Client registrations, codes, tokens and dashboard
  sessions are AES-256-GCM-encrypted blobs with a separate HKDF-derived key per purpose, so one
  kind can never be replayed as another. A user's Google refresh token exists only inside the
  encrypted tokens held by their own MCP client and browser. Trade-offs: individual tokens can't
  be revoked server-side (rotate `GSCLAW_ENCRYPTION_KEY`, or `GSCLAW_ACCESS_TOKEN` in
  service-account mode, to revoke everything; users can also revoke GSClaw in their Google
  Account), and an authorization code stays valid for its 60-second lifetime rather than being
  single-use (PKCE ties it to the client that started the flow).
- Writes (sitemap submit/delete) are off unless `GSCLAW_ALLOW_WRITES=true`; read-only
  deployments only request the `webmasters.readonly` scope.
- Tokens, keys and Search Console response data are never logged at `info` level; log fields
  that look like credentials are redacted at every level.
- Browser `Origin` headers are validated; loopback-bound servers also validate `Host`.
- Configuration errors name variables but never echo their values.
