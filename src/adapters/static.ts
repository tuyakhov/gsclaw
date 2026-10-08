import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

/**
 * Locates dist/public whether we run from the bundle (dist/*.js, dist/adapters/*.js) or from
 * source via tsx (src/adapters/*.ts). GSCLAW_STATIC_DIR overrides.
 */
export function findStaticDir(override?: string): string | null {
  const candidates = override
    ? [override]
    : ['./public/', '../public/', '../../dist/public/'].map((rel) =>
        fileURLToPath(new URL(rel, import.meta.url)),
      );
  return candidates.find((dir) => existsSync(dir)) ?? null;
}

/** Serves files below `root` for GET/HEAD. Returns null when nothing matches. */
export function createStaticHandler(root: string): (request: Request) => Promise<Response | null> {
  const base = normalize(root.endsWith(sep) ? root : root + sep);
  return async (request) => {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return null;
    }
    if (pathname.includes('\0')) return null;
    const file = normalize(join(base, pathname));
    if (!file.startsWith(base)) return null; // path traversal
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const headers = {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        etag,
        'x-content-type-options': 'nosniff',
      };
      if (request.headers.get('if-none-match') === etag)
        return new Response(null, { status: 304, headers });
      const body = request.method === 'HEAD' ? null : await readFile(file);
      return new Response(body, { headers: { ...headers, 'content-length': String(info.size) } });
    } catch {
      return null;
    }
  };
}
