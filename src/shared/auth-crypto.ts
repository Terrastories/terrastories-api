/**
 * Portable WebCrypto helpers for the client-stretching auth protocol
 * (SPEC-V2 §6.2, §7). Pure WebCrypto only — no Node `crypto`, no `Buffer` —
 * so the same module runs in workerd, Node 18+ and the field kit.
 */

const encoder = new TextEncoder();

/** Lowercase hex of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Base64 of a byte array (`btoa` is available in workerd and Node 18+). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64url of a byte array (no padding, `-` and `_` alphabets). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

/** Decode lowercase/uppercase hex into bytes. */
export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

/** HMAC-SHA256 of a UTF-8 input under a UTF-8 secret, lowercase hex. */
export async function hmacSha256Hex(
  secret: string,
  input: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(input)
  );
  return toHex(new Uint8Array(signature));
}

/** HMAC-SHA256 of a UTF-8 input under a UTF-8 secret, raw digest bytes. */
export async function hmacSha256Bytes(
  secret: string,
  input: string
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(input)
  );
  return new Uint8Array(signature);
}

/**
 * Constant-time comparison of two equal-length strings. The length check
 * returns early (length is not secret); the content loop always walks the
 * whole string and folds differences into one accumulator.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/** Read four bytes as an unsigned big-endian integer. */
export function readUint32(bytes: Uint8Array, offset = 0): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}
