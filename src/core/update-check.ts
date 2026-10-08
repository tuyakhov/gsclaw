import { VERSION } from './version.js';

const RELEASES_URL = 'https://api.github.com/repos/tuyakhov/gsclaw/releases/latest';
const CACHE_MS = 6 * 3600_000;

let cached: { at: number; latest: string | null } | undefined;

/** Compares dotted numeric versions; pre-release suffixes are ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Latest published GSClaw release (cached for 6 hours per instance). Any failure (offline,
 * rate-limited, no releases yet) yields null so the dashboard simply shows no notice.
 */
export async function latestRelease(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  now = Date.now(),
): Promise<string | null> {
  if (cached && now - cached.at < CACHE_MS) return cached.latest;
  let latest: string | null = null;
  try {
    const res = await fetchImpl(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `gsclaw/${VERSION}` },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const body = (await res.json()) as { tag_name?: unknown };
      if (typeof body.tag_name === 'string') latest = body.tag_name.replace(/^v/, '');
    }
  } catch {
    latest = null;
  }
  cached = { at: now, latest };
  return latest;
}

export function resetUpdateCheckCache(): void {
  cached = undefined;
}
