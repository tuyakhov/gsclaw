// OAuth clients without a database: Dynamic Client Registration hands out client IDs that are
// sealed blobs of the client's metadata, and Client ID Metadata Documents (CIMD) are fetched from
// the client's own URL. Redirect URIs are restricted to known MCP clients and loopback by default.
import type { Sealer } from '../seal.js';

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  /** "dcr" = registered here; "cimd" = metadata document at the client_id URL. */
  type: 'dcr' | 'cimd';
}

/** Redirect hosts of popular remote-MCP clients. Extend with GSCLAW_OAUTH_REDIRECT_HOSTS. */
export const DEFAULT_REDIRECT_HOSTS = [
  'claude.ai',
  'claude.com',
  'chatgpt.com',
  'cursor.com',
  'www.cursor.com',
  'vscode.dev',
  'insiders.vscode.dev',
];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const DCR_TTL_SECONDS = 10 * 365 * 24 * 3600;

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Loopback http redirects (desktop and CLI clients) are always allowed; https redirects must go to
 * a known client host or one listed in GSCLAW_OAUTH_REDIRECT_HOSTS ("*" allows any https host).
 */
export function redirectUriAllowed(uri: string, extraHosts: string[]): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname);
  if (url.protocol !== 'https:') return false;
  if (extraHosts.includes('*')) return true;
  return [...DEFAULT_REDIRECT_HOSTS, ...extraHosts].includes(url.hostname.toLowerCase());
}

/** Loopback redirect URIs match regardless of port (RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return (
      a.protocol === 'http:' &&
      LOOPBACK.has(a.hostname) &&
      a.hostname === b.hostname &&
      a.protocol === b.protocol &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

interface SealedClient {
  n: string;
  r: string[];
}

/** RFC 7591 registration. The returned client_id *is* the registration. */
export async function registerClient(
  body: unknown,
  sealer: Sealer,
  extraHosts: string[],
): Promise<Record<string, unknown>> {
  const meta = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const requested = meta.redirect_uris;
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > 10) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array.');
  }
  const redirectUris: string[] = [];
  for (const uri of requested as unknown[]) {
    if (typeof uri !== 'string' || !redirectUriAllowed(uri, extraHosts)) {
      throw new OAuthError(
        'invalid_redirect_uri',
        `Redirect URI not allowed: ${String(uri).slice(0, 200)}. Use a loopback URI or a known client; the deployment owner can allow more hosts with GSCLAW_OAUTH_REDIRECT_HOSTS.`,
      );
    }
    redirectUris.push(uri);
  }
  const authMethod = meta.token_endpoint_auth_method ?? 'none';
  if (authMethod !== 'none') {
    throw new OAuthError(
      'invalid_client_metadata',
      'Only public clients are supported (token_endpoint_auth_method "none").',
    );
  }
  const name =
    typeof meta.client_name === 'string' && meta.client_name.trim()
      ? meta.client_name.trim().slice(0, 100)
      : 'MCP client';
  const clientId = await sealer.seal(
    'client',
    { n: name, r: redirectUris } satisfies SealedClient,
    DCR_TTL_SECONDS,
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

const cimdCache = new Map<string, { client: OAuthClient; expiresAt: number }>();

/** Refuses obviously internal targets. Workers cannot resolve DNS, so hostnames are allowed. */
function publicHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (
    LOOPBACK.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  )
    return null;
  if (/^\[/.test(host)) return null; // IPv6 literals
  const ipv4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    ) {
      return null;
    }
  }
  return url;
}

/** Fetches and validates a Client ID Metadata Document, cached for 10 minutes per instance. */
async function resolveCimd(
  clientId: string,
  fetchImpl: typeof fetch,
  extraHosts: string[],
): Promise<OAuthClient> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.client;
  const url = publicHttpsUrl(clientId);
  if (!url) throw new OAuthError('invalid_client', 'client_id URL must be a public https URL.');
  let doc: Record<string, unknown>;
  try {
    const res = await fetchImpl(url.href, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok || text.length > 65_536) throw new Error(`HTTP ${res.status}`);
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthError('invalid_client', 'Could not fetch the client metadata document.');
  }
  if (doc.client_id !== clientId)
    throw new OAuthError('invalid_client', 'Client metadata client_id does not match its URL.');
  const redirectUris = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter((u): u is string => typeof u === 'string')
    : [];
  if (redirectUris.length === 0)
    throw new OAuthError('invalid_client', 'Client metadata has no redirect_uris.');
  if (typeof doc.client_name !== 'string' || !doc.client_name.trim()) {
    throw new OAuthError('invalid_client', 'Client metadata has no client_name.');
  }
  const client: OAuthClient = {
    clientId,
    name: doc.client_name.trim().slice(0, 100),
    redirectUris: redirectUris.filter((u) => redirectUriAllowed(u, extraHosts)),
    type: 'cimd',
  };
  cimdCache.set(clientId, { client, expiresAt: Date.now() + 10 * 60_000 });
  return client;
}

/** Looks up a client by ID: a sealed DCR registration or a CIMD URL. */
export async function resolveClient(
  clientId: string,
  deps: { sealer: Sealer; fetch: typeof fetch; extraHosts: string[] },
): Promise<OAuthClient> {
  if (clientId.startsWith('https://')) return resolveCimd(clientId, deps.fetch, deps.extraHosts);
  const sealed = await deps.sealer.open<SealedClient>('client', clientId);
  if (!sealed)
    throw new OAuthError(
      'invalid_client',
      'Unknown client. Re-register the client (remove and re-add the connector).',
      401,
    );
  return {
    clientId,
    name: sealed.n,
    redirectUris: sealed.r.filter((u) => redirectUriAllowed(u, deps.extraHosts)),
    type: 'dcr',
  };
}

export function clearClientCache(): void {
  cimdCache.clear();
}
