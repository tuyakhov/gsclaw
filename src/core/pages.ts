import type { ConfigIssue } from './config.js';
import { REPO_URL, VERSION } from './version.js';

export const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const HTML_SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

export function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escape(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1c1b1a;--muted:#6b6862;--bg:#faf9f7;--card:#fff;--line:#e6e3de;--accent:#0d9488;--accent-text:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#ecebe8;--muted:#a19e98;--bg:#151413;--card:#1e1d1b;--line:#33312e;--accent:#2dd4bf;--accent-text:#062b27}}
body{margin:0;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{max-width:560px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0;color:var(--muted)}a{color:var(--accent)}
ul{padding-left:1.2rem}li{margin:.35rem 0}code{font-size:.9em}
form{display:grid;gap:10px;margin-top:16px}label{font-weight:600;font-size:.9rem}
input{font:inherit;height:40px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:4px}
button,.button{font:inherit;font-weight:600;height:40px;border-radius:8px;padding:0 16px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.client{background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:14px 0;color:var(--fg)}
.client small{display:block;color:var(--muted)}.warn{color:#b45309}.error{color:#b91c1c;margin:0}
</style></head><body><main>${body}</main></body></html>`;
}

/** Minimal public page: confirms the server runs, reveals nothing about its configuration. */
export function runningPage(): string {
  return layout(
    'GSClaw',
    `<h1>GSClaw is running</h1>
<p>This is a Google Search Console MCP server. Connect it from your AI client; the endpoint requires authentication.</p>
<p><a href="${REPO_URL}#readme">Documentation</a></p>`,
  );
}

/** Shown on serverless deployments that are missing configuration (names only, never values). */
export function setupPage(issues: ConfigIssue[]): string {
  const items = issues
    .map(
      (i) =>
        `<li>${i.variable ? `<code>${escape(i.variable)}</code> ` : ''}${escape(i.message)}</li>`,
    )
    .join('');
  return layout(
    'GSClaw setup required',
    `<h1>GSClaw needs configuration</h1>
<p>This deployment is not configured yet, so it refuses to serve requests. Set these environment variables in your hosting dashboard and redeploy:</p>
<ul>${items}</ul>
<p><a href="${REPO_URL}#quickstart">Setup guide</a> · v${escape(VERSION)}</p>`,
  );
}
