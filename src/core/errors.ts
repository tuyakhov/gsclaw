import type { GoogleErrorBody } from './gsc/types.js';

/** An error whose message is written for the end user (and their AI) and safe to show verbatim. */
export class UserFacingError extends Error {
  readonly kind: string;
  constructor(message: string, kind = 'invalid_input') {
    super(message);
    this.name = 'UserFacingError';
    this.kind = kind;
  }
}

export type GscErrorKind =
  | 'permission'
  | 'api_disabled'
  | 'not_found'
  | 'invalid_argument'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'auth'
  | 'server'
  | 'network';

export interface Identity {
  kind: 'service_account' | 'user';
  email: string;
  projectId?: string;
}

export class GscApiError extends UserFacingError {
  readonly status: number;
  readonly reason?: string;
  readonly googleMessage: string;
  readonly retryable: boolean;

  constructor(opts: {
    kind: GscErrorKind;
    status: number;
    advice: string;
    googleMessage: string;
    reason?: string;
    retryable?: boolean;
  }) {
    const suffix = opts.googleMessage ? `\n\nGoogle said: ${opts.googleMessage}` : '';
    super(`${opts.advice}${suffix}`, opts.kind);
    this.name = 'GscApiError';
    this.status = opts.status;
    this.reason = opts.reason;
    this.googleMessage = opts.googleMessage;
    this.retryable = opts.retryable ?? false;
  }
}

const RATE_LIMIT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'rateLimitExceededUnreg',
]);
const DAILY_QUOTA_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'dailyLimitExceededUnreg',
]);

function who(identity: Identity): string {
  return identity.kind === 'service_account'
    ? `The service account ${identity.email}`
    : `Your Google account (${identity.email})`;
}

/** Turns a Google API error response into an actionable message. */
export function toGscApiError(
  status: number,
  body: unknown,
  ctx: { identity: Identity; siteUrl?: string },
): GscApiError {
  const err = (body as GoogleErrorBody | undefined)?.error;
  const googleMessage = (err?.message ?? (typeof body === 'string' ? body : '')).slice(0, 500);
  const reasons = new Set<string>();
  for (const e of err?.errors ?? []) if (e.reason) reasons.add(e.reason);
  for (const d of err?.details ?? []) if (d.reason) reasons.add(d.reason);
  if (err?.status) reasons.add(err.status);
  const reason = [...reasons][0];
  const has = (...names: string[]) => names.some((n) => reasons.has(n));
  const site = ctx.siteUrl ? `'${ctx.siteUrl}'` : 'this property';
  const { identity } = ctx;

  if (
    status === 429 ||
    has(...RATE_LIMIT_REASONS) ||
    (has('RESOURCE_EXHAUSTED') && !has(...DAILY_QUOTA_REASONS))
  ) {
    return new GscApiError({
      kind: 'rate_limited',
      status,
      reason,
      googleMessage,
      retryable: true,
      advice:
        "Google's Search Console API rate limit was hit (Search Analytics allows ~1,200 queries/min per site; URL Inspection 600/min). " +
        'Wait a minute and retry. If it keeps happening, use shorter date ranges or fewer page/query breakdowns, which count heavier against the load quota.',
    });
  }

  if (has(...DAILY_QUOTA_REASONS)) {
    return new GscApiError({
      kind: 'quota_exceeded',
      status,
      reason,
      googleMessage,
      advice:
        'The daily Search Console API quota is used up (URL Inspection allows 2,000 inspections per property per day). It resets at midnight Pacific Time.',
    });
  }

  if (
    has('SERVICE_DISABLED', 'accessNotConfigured') ||
    /has not been used in project|is disabled/i.test(googleMessage)
  ) {
    const project = identity.projectId ?? googleMessage.match(/project (\d+|[a-z][a-z0-9-]+)/)?.[1];
    const link = `https://console.cloud.google.com/apis/library/searchconsole.googleapis.com${project ? `?project=${project}` : ''}`;
    return new GscApiError({
      kind: 'api_disabled',
      status,
      reason,
      googleMessage,
      advice: `The Google Search Console API is not enabled for the Google Cloud project${project ? ` "${project}"` : ''}. Enable it at ${link}, wait a minute, then retry.`,
    });
  }

  if (status === 401) {
    return new GscApiError({
      kind: 'auth',
      status,
      reason,
      googleMessage,
      advice:
        identity.kind === 'service_account'
          ? 'Google rejected the service-account credentials. The key may have been deleted or rotated: create a new JSON key in Google Cloud and update GOOGLE_SERVICE_ACCOUNT_JSON.'
          : 'Your Google sign-in has expired or was revoked. Reconnect GSClaw in your AI client to sign in again.',
    });
  }

  if (status === 403) {
    const fix =
      identity.kind === 'service_account'
        ? `In Search Console, open the property → Settings → Users and permissions → Add user, and add ${identity.email} (Restricted is enough for reading; Full is needed for sitemap changes).`
        : 'Ask an owner of the property to add your Google account in Search Console → Settings → Users and permissions.';
    return new GscApiError({
      kind: 'permission',
      status,
      reason,
      googleMessage,
      advice:
        `${who(identity)} does not have access to ${site}. ${fix} ` +
        "Also check the property format: domain properties look like 'sc-domain:example.com', URL-prefix properties like 'https://www.example.com/' (exact scheme, www and trailing slash). Run list_sites to see every property this server can read.",
    });
  }

  if (status === 404) {
    return new GscApiError({
      kind: 'not_found',
      status,
      reason,
      googleMessage,
      advice: `Not found. Check the property and URL: run list_sites for valid properties, and pass sitemaps as full URLs exactly as list_sitemaps shows them.`,
    });
  }

  if (status === 400) {
    return new GscApiError({
      kind: 'invalid_argument',
      status,
      reason,
      googleMessage,
      advice:
        'Google rejected the request parameters. Common causes: searchAppearance combined with other dimensions, aggregation_type "byProperty" with a page dimension/filter, Discover/Google News with query or position data, or dates older than 16 months.',
    });
  }

  return new GscApiError({
    kind: 'server',
    status,
    reason,
    googleMessage,
    retryable: status >= 500,
    advice: `Google's Search Console API returned an error (HTTP ${status}). This is usually temporary; try again shortly.`,
  });
}

/** Message for any thrown value, safe to return to clients. Unknown errors are not echoed in detail. */
export function publicErrorMessage(error: unknown): { message: string; kind: string } {
  if (error instanceof UserFacingError) return { message: error.message, kind: error.kind };
  return {
    message: 'Unexpected internal error. Check the server logs for details.',
    kind: 'internal',
  };
}
