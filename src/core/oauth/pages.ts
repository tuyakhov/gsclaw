import { HTML_SECURITY_HEADERS, escape, layout } from '../pages.js';

export interface ConsentInfo {
  clientName: string;
  redirectUri: string;
  /** Sealed authorization request, posted back with the decision. */
  request: string;
  canWrite: boolean;
  error?: string;
}

function hostOf(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' ? `${url.hostname} (an app on this computer)` : url.host;
  } catch {
    return uri;
  }
}

/**
 * HTML headers for consent pages. Browsers apply `form-action` to the redirect that follows a form
 * submission, so the client's redirect origin must be allowed alongside 'self'.
 */
export function consentHeaders(
  redirectUri: string,
  extraOrigins: string[] = [],
): Record<string, string> {
  const origins = [...extraOrigins];
  try {
    origins.push(new URL(redirectUri).origin);
  } catch {
    // keep 'self' only
  }
  return {
    ...HTML_SECURITY_HEADERS,
    'content-security-policy': HTML_SECURITY_HEADERS['content-security-policy']!.replace(
      "form-action 'self'",
      ["form-action 'self'", ...origins].join(' '),
    ),
  };
}

function clientBlock(info: ConsentInfo): string {
  return `<div class="client"><strong>${escape(info.clientName)}</strong>
<small>will receive access at ${escape(hostOf(info.redirectUri))}</small></div>`;
}

function access(info: ConsentInfo): string {
  return info.canWrite
    ? 'read your Search Console data and submit or remove sitemaps'
    : 'read your Search Console data (read-only)';
}

/** Service-account mode: the owner confirms with the deployment's access token. */
export function ownerConsentPage(info: ConsentInfo): string {
  return layout(
    'Connect to GSClaw',
    `<h1>Allow access to GSClaw?</h1>
${clientBlock(info)}
<p>This app wants to ${access(info)} through this GSClaw deployment. Only continue if you started this connection.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escape(info.request)}">
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>
${info.error ? `<p class="error" role="alert">${escape(info.error)}</p>` : ''}
<div class="actions">
<button class="primary" type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
</div>
</form>`,
  );
}

/** OAuth mode: confirm the client, then continue to Google sign-in. */
export function googleConsentPage(info: ConsentInfo): string {
  return layout(
    'Connect to GSClaw',
    `<h1>Allow access to GSClaw?</h1>
${clientBlock(info)}
<p>This app wants to ${access(info)} through this GSClaw deployment. Sign in with the Google account that has access to your Search Console properties.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request" value="${escape(info.request)}">
<div class="actions">
<button class="primary" type="submit" name="decision" value="allow">Continue with Google</button>
<button type="submit" name="decision" value="deny">Deny</button>
</div>
</form>`,
  );
}

export function oauthErrorPage(title: string, message: string): string {
  return layout('GSClaw sign-in', `<h1>${escape(title)}</h1><p>${escape(message)}</p>`);
}
