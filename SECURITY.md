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
- Service-account mode: clients present `GSCLAW_ACCESS_TOKEN` as a bearer header (preferred) or
  in the secret path `/mcp/<token>`. Comparisons are constant-time; wrong secret paths return 404.
  Secret paths can appear in hosting providers' request logs, so prefer the bearer header (or
  OAuth sign-in, coming soon) where your client supports it, and disable the secret path with
  `GSCLAW_SECRET_PATH=false` if you don't need it. Rotating the token revokes access.
- Writes (sitemap submit/delete) are off unless `GSCLAW_ALLOW_WRITES=true`; read-only
  deployments only request the `webmasters.readonly` scope.
- Tokens, keys and Search Console response data are never logged at `info` level; log fields
  that look like credentials are redacted at every level.
- Browser `Origin` headers are validated; loopback-bound servers also validate `Host`.
- Configuration errors name variables but never echo their values.
