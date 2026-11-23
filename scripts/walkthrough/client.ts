/**
 * HTTP client for the walkthrough: fetch plus a per-actor cookie jar.
 * Cookies, tokens and derived keys never leave this module in clear text:
 * the recorder redacts every value registered through Run.secret().
 */
import { createHash } from 'node:crypto';

export interface Reply {
  status: number;
  headers: Headers;
  json: unknown;
  text: string;
  bytes: Uint8Array;
}

export interface CallOptions {
  json?: unknown;
  form?: FormData;
  /** Raw request body (media uploads, #249); the caller sets content-type. */
  rawBody?: Uint8Array;
  headers?: Record<string, string>;
  /** Do not send the actor's cookie (an anonymous probe). */
  noCookie?: boolean;
}

/** Plain HTTP is acceptable only to the local machine. */
export function isLocalHost(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export class CookieJar {
  private cookies = new Map<string, { value: string; secure: boolean }>();
  /**
   * The Cookie header for a request to `url`. A cookie the server marked
   * Secure is never sent over plain http:// (except to localhost): that is
   * refused with a clear error instead of leaking a session token.
   */
  header(url?: URL): string | undefined {
    if (this.cookies.size === 0) return undefined;
    const plain =
      url !== undefined && url.protocol === 'http:' && !isLocalHost(url);
    const parts: string[] = [];
    for (const [k, c] of this.cookies) {
      if (c.secure && plain)
        throw new Error(
          `refusing to send the Secure cookie "${k}" over plain HTTP to ${url.host}: use https://`
        );
      parts.push(`${k}=${c.value}`);
    }
    return parts.join('; ');
  }
  values(): string[] {
    return [...this.cookies.values()].map((c) => c.value);
  }
  absorb(headers: Headers): void {
    const lines = headers.getSetCookie?.() ?? [];
    for (const line of lines) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('=');
      if (eq < 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const maxAge = attrs
        .map((a) => a.trim().toLowerCase())
        .find((a) => a.startsWith('max-age='));
      if (value === '' || maxAge === 'max-age=0') this.cookies.delete(name);
      else
        this.cookies.set(name, {
          value,
          secure: attrs.some((a) => a.trim().toLowerCase() === 'secure'),
        });
    }
  }
  clear(): void {
    this.cookies.clear();
  }
  get signedIn(): boolean {
    return this.cookies.size > 0;
  }
}

export class Actor {
  readonly jar = new CookieJar();
  /** Set once the actor has logged in. */
  userId: number | undefined;
  /** Held in memory only; never printed. */
  password: string | undefined;
  identifier: string | undefined;
  /** Keep the cookie of a finished session, to replay it after logout. */
  savedCookie: string | undefined;
  constructor(
    readonly baseUrl: string,
    readonly name: string,
    readonly role: string,
    readonly onSecret: (value: string) => void
  ) {}

  async call(
    method: string,
    path: string,
    options: CallOptions = {}
  ): Promise<Reply> {
    const headers = new Headers(options.headers);
    const target = new URL(path, this.baseUrl);
    const cookie = options.noCookie ? undefined : this.jar.header(target);
    if (cookie) headers.set('cookie', cookie);
    let body: string | FormData | Uint8Array | undefined;
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form;
    } else if (options.rawBody) {
      body = options.rawBody;
      headers.set('content-length', String(options.rawBody.byteLength));
    }
    const response = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!options.noCookie) {
      this.jar.absorb(response.headers);
      for (const value of this.jar.values()) this.onSecret(value);
    }
    const text = new TextDecoder().decode(bytes);
    let json: unknown = null;
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('json') && text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      json,
      text,
      bytes,
    };
  }
}

/**
 * Raw-body upload for `POST /v2/media` (#249): the file bytes are the request
 * body; filename and binding fields go in the query, the declared type in
 * Content-Type, and the client SHA-256 in `x-content-sha256`. Spread the
 * result into a step: `{ method: 'POST', path: '/v2/media', ...rawUpload(...) }`.
 */
export function rawUpload(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Uint8Array }
): { path: string; rawBody: Uint8Array; headers: Record<string, string> } {
  const query = new URLSearchParams({ filename: file.name, ...fields });
  return {
    path: `/v2/media?${query.toString()}`,
    rawBody: file.bytes,
    headers: {
      'content-type': file.type,
      'x-content-sha256': createHash('sha256').update(file.bytes).digest('hex'),
    },
  };
}

/** Build a multipart body; fields go first so `role` precedes `file`. */
export function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Uint8Array },
  extras: Array<{
    field: string;
    name: string;
    type: string;
    bytes: Uint8Array;
  }> = []
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', new Blob([file.bytes], { type: file.type }), file.name);
  for (const extra of extras)
    form.append(
      extra.field,
      new Blob([extra.bytes], { type: extra.type }),
      extra.name
    );
  return form;
}

/** Tiny valid media so uploads pass the server's magic-byte sniffing. */
export const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

export function wavBytes(): Uint8Array {
  const buf = new Uint8Array(44);
  const view = new DataView(buf.buffer);
  const enc = new TextEncoder();
  buf.set(enc.encode('RIFF'), 0);
  view.setUint32(4, 36, true);
  buf.set(enc.encode('WAVEfmt '), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  buf.set(enc.encode('data'), 36);
  return buf;
}
