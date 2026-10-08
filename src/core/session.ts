import { base64ToBytes, base64UrlEncode, sha256, utf8 } from './crypto.js';

export const SESSION_COOKIE = 'gsclaw_session';
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;

export interface SessionPayload {
  /** Subject: "owner" in service-account mode. */
  sub: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

type HmacKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * The signing key is derived from the deployment secret, so rotating GSCLAW_ACCESS_TOKEN signs
 * everyone out of the dashboard as well.
 */
async function signingKey(secret: string): Promise<HmacKey> {
  const raw = await sha256(`gsclaw-dashboard-session-v1:${secret}`);
  return crypto.subtle.importKey(
    'raw',
    new Uint8Array(raw),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** `v1.<payload>.<signature>`, all base64url. */
export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = `v1.${base64UrlEncode(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('HMAC', await signingKey(secret), utf8(body));
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(
  value: string | undefined,
  secret: string,
  nowSeconds: number,
): Promise<SessionPayload | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      base64ToBytes(parts[2]!),
      utf8(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(base64ToBytes(parts[1]!)),
    ) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
    if (typeof payload.sub !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

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
 * where some browsers would otherwise drop the cookie.
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
