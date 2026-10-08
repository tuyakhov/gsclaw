// Stateless, tamper-proof tokens: JSON payloads encrypted with AES-256-GCM under keys derived (HKDF)
// from one deployment secret, with a separate key per purpose. A sealed authorization code can
// therefore never be replayed as an access token, a client ID, or a session.
import { base64ToBytes, base64UrlEncode, utf8 } from './crypto.js';

export type SealPurpose =
  'client' | 'state' | 'request' | 'code' | 'access' | 'refresh' | 'session';

/** Short visible prefixes make tokens recognisable in logs and support tickets (never their content). */
export const SEAL_PREFIX: Record<SealPurpose, string> = {
  client: 'gsc_client_',
  state: 'gsc_state_',
  request: 'gsc_req_',
  code: 'gsc_code_',
  access: 'gsc_at_',
  refresh: 'gsc_rt_',
  session: 'gsc_sess_',
};

type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export interface Sealer {
  seal(purpose: SealPurpose, payload: object, ttlSeconds: number): Promise<string>;
  /** Returns null for anything malformed, tampered with, of another purpose, or expired. */
  open<T extends object>(
    purpose: SealPurpose,
    token: string | null | undefined,
  ): Promise<(T & { exp: number }) | null>;
}

export function createSealer(secret: string, now: () => number = Date.now): Sealer {
  const keys = new Map<SealPurpose, Promise<AesKey>>();

  const keyFor = (purpose: SealPurpose): Promise<AesKey> => {
    let key = keys.get(purpose);
    if (!key) {
      key = (async () => {
        const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, [
          'deriveKey',
        ]);
        return crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: utf8('gsclaw-seal-v1'),
            info: utf8(`gsclaw:${purpose}`),
          },
          material,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        );
      })();
      keys.set(purpose, key);
    }
    return key;
  };

  return {
    async seal(purpose, payload, ttlSeconds) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = utf8(JSON.stringify({ ...payload, exp: Math.floor(now() / 1000) + ttlSeconds }));
      const cipher = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: utf8(purpose) },
          await keyFor(purpose),
          body,
        ),
      );
      const out = new Uint8Array(iv.length + cipher.length);
      out.set(iv);
      out.set(cipher, iv.length);
      return SEAL_PREFIX[purpose] + base64UrlEncode(out);
    },

    async open<T extends object>(purpose: SealPurpose, token: string | null | undefined) {
      const prefix = SEAL_PREFIX[purpose];
      if (!token?.startsWith(prefix) || token.length > 8192) return null;
      try {
        const bytes = base64ToBytes(token.slice(prefix.length));
        if (bytes.length < 13 + 16) return null;
        const plain = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: bytes.subarray(0, 12), additionalData: utf8(purpose) },
          await keyFor(purpose),
          bytes.subarray(12),
        );
        const payload = JSON.parse(new TextDecoder().decode(plain)) as T & { exp: number };
        if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now() / 1000)) return null;
        return payload;
      } catch {
        return null;
      }
    },
  };
}
