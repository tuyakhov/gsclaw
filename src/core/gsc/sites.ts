import { UserFacingError } from '../errors.js';
import type { GscClient } from './client.js';
import type { SiteEntry } from './types.js';

export type PermissionLevel = 'owner' | 'full' | 'restricted' | 'unverified' | 'unknown';

export interface Property {
  site_url: string;
  type: 'domain' | 'url_prefix';
  /** Domain for `sc-domain:` properties, host for URL-prefix properties. */
  host: string;
  permission_level: PermissionLevel;
  /** False for unverified entries, which expose no data. */
  has_access: boolean;
}

export function normalizePermission(level: string): PermissionLevel {
  switch (level.replace(/_/g, '').toLowerCase()) {
    case 'siteowner':
      return 'owner';
    case 'sitefulluser':
      return 'full';
    case 'siterestricteduser':
      return 'restricted';
    case 'siteunverifieduser':
      return 'unverified';
    default:
      return 'unknown';
  }
}

export function toProperty(entry: SiteEntry): Property {
  const permission = normalizePermission(entry.permissionLevel);
  const isDomain = entry.siteUrl.startsWith('sc-domain:');
  let host = entry.siteUrl;
  if (isDomain) host = entry.siteUrl.slice('sc-domain:'.length);
  else {
    try {
      host = new URL(entry.siteUrl).host;
    } catch {
      // keep raw value
    }
  }
  return {
    site_url: entry.siteUrl,
    type: isDomain ? 'domain' : 'url_prefix',
    host: host.toLowerCase(),
    permission_level: permission,
    has_access: permission !== 'unverified',
  };
}

export async function listProperties(
  client: GscClient,
  opts: { fresh?: boolean } = {},
): Promise<Property[]> {
  const entries = await client.listSites(opts);
  return entries
    .map(toProperty)
    .sort(
      (a, b) =>
        Number(b.has_access) - Number(a.has_access) ||
        Number(b.type === 'domain') - Number(a.type === 'domain') ||
        a.site_url.localeCompare(b.site_url),
    );
}

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

/** True if `property` would contain data for `url`. */
export function propertyCoversUrl(property: Property, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.host.toLowerCase();
  if (property.type === 'domain') {
    return host === property.host || host.endsWith(`.${property.host}`);
  }
  return url.startsWith(property.site_url) || `${url}/` === property.site_url;
}

function describeAvailable(properties: Property[]): string {
  const usable = properties.filter((p) => p.has_access);
  if (usable.length === 0) {
    return 'This server cannot read any Search Console property yet. Add its Google identity as a user on your properties (Search Console → Settings → Users and permissions).';
  }
  const list = usable
    .slice(0, 20)
    .map((p) => `'${p.site_url}'`)
    .join(', ');
  return `Available properties: ${list}${usable.length > 20 ? `, … (${usable.length} total)` : ''}.`;
}

/**
 * Resolves user input ('sc-domain:example.com', 'https://www.example.com/', 'example.com',
 * or any URL on the site) to a property this identity can read.
 */
export async function resolveProperty(client: GscClient, input: string): Promise<Property> {
  const properties = await listProperties(client);
  const usable = properties.filter((p) => p.has_access);
  const raw = input.trim();
  const lower = raw.toLowerCase();

  const exact = properties.find(
    (p) => p.site_url.toLowerCase() === lower || p.site_url.toLowerCase() === `${lower}/`,
  );
  if (exact) {
    if (!exact.has_access) {
      throw new UserFacingError(
        `'${exact.site_url}' is listed but unverified for this identity, so Search Console exposes no data for it. Verify ownership or ask an owner for access. ${describeAvailable(properties)}`,
        'permission',
      );
    }
    return exact;
  }

  if (lower.startsWith('sc-domain:')) {
    throw new UserFacingError(
      `No access to '${raw}'. ${describeAvailable(properties)}`,
      'not_found',
    );
  }

  const hasScheme = /^https?:\/\//.test(lower);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    throw new UserFacingError(
      `'${raw}' is not a valid property, domain or URL. ${describeAvailable(properties)}`,
    );
  }
  const host = url.host.toLowerCase();

  const domainMatch = usable
    .filter((p) => p.type === 'domain' && (host === p.host || host.endsWith(`.${p.host}`)))
    .sort((a, b) => b.host.length - a.host.length)[0];

  const prefixMatches = usable
    .filter((p) => p.type === 'url_prefix')
    .filter((p) => {
      if (hasScheme) return propertyCoversUrl(p, url.href);
      // Bare domains match any scheme and www/non-www variant of the same host.
      return (
        stripWww(p.host) === stripWww(host) &&
        (url.pathname === '/' || propertyCoversUrl(p, `https://${p.host}${url.pathname}`))
      );
    })
    .sort((a, b) => {
      if (b.site_url.length !== a.site_url.length && hasScheme)
        return b.site_url.length - a.site_url.length;
      // Prefer https and the exact host the user typed.
      const score = (p: Property) =>
        (p.site_url.startsWith('https://') ? 2 : 0) + (p.host === host ? 1 : 0);
      return score(b) - score(a);
    });

  // A full URL is most specific to its URL-prefix property; a bare domain is best served by the
  // domain property, which covers every host and protocol.
  const match = hasScheme ? (prefixMatches[0] ?? domainMatch) : (domainMatch ?? prefixMatches[0]);
  if (match) return match;

  throw new UserFacingError(
    `No Search Console property matches '${raw}'. ${describeAvailable(properties)}`,
    'not_found',
  );
}

/** Resolves a page given as an absolute URL or a path ('/pricing') against a property. */
export function absolutePageUrl(property: Property, page: string): string | null {
  if (/^https?:\/\//i.test(page)) return page;
  if (!page.startsWith('/')) return null;
  if (property.type === 'url_prefix')
    return new URL(page.replace(/^\//, ''), property.site_url).href;
  return null;
}
