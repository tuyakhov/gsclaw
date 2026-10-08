// Runtime-agnostic crypto helpers built on WebCrypto, atob/btoa and TextEncoder only.

const encoder = new TextEncoder();

export function utf8(input: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(input);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? utf8(input) : input;
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(input)));
}

export async function sha256Hex(input: string): Promise<string> {
  return [...(await sha256(input))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison. Both inputs are hashed first so the comparison time does not
 * depend on where the strings differ or on their lengths.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}
