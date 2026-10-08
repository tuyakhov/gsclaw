// Dashboard session cookies. The value is a sealed blob (see seal.ts / oauth/server.ts); these
// helpers only deal with the cookie itself.

export const SESSION_COOKIE = 'gsclaw_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * httpOnly + SameSite=Strict always. `Secure` everywhere except plain-http loopback development,
 * where some browsers would otherwise drop the cookie. Strict is enough even after the cross-site
 * return from Google sign-in: the HTML shell needs no cookie, and every API call is same-origin.
 */
export function sessionCookie(value: string, opts: { secure: boolean; maxAge?: number }): string {
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${opts.maxAge ?? SESSION_MAX_AGE_SECONDS}`,
  ];
  if (opts.secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie('', { secure, maxAge: 0 });
}
