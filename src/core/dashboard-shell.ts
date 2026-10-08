import { VERSION } from './version.js';

/** Strict CSP: the dashboard only loads its own bundle and talks to its own API. */
export const DASHBOARD_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

/**
 * The dashboard's HTML shell. It contains no data; the app behind it requires a session.
 * Assets have fixed names and are cache-busted with the version.
 */
export function dashboardShell(): string {
  const v = encodeURIComponent(VERSION);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>GSClaw</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/dashboard.css?v=${v}">
<script type="module" src="/assets/dashboard.js?v=${v}"></script>
</head>
<body>
<div id="app"><noscript>GSClaw's dashboard needs JavaScript.</noscript></div>
</body>
</html>`;
}
