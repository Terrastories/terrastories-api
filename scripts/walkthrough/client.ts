/**
 * HTTP client for the walkthrough: fetch plus a per-actor cookie jar.
 * Cookies, tokens and derived keys never leave this module in clear text:
 * the recorder redacts every value registered through Run.secret().
 */
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
  headers?: Record<string, string>;
  /** Do not send the actor's cookie (an anonymous probe). */
  noCookie?: boolean;
}

export class CookieJar {
  private cookies = new Map<string, string>();
  header(): string | undefined {
    if (this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  values(): string[] {
    return [...this.cookies.values()];
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
      else this.cookies.set(name, value);
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
    const cookie = options.noCookie ? undefined : this.jar.header();
    if (cookie) headers.set('cookie', cookie);
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.json);
    } else if (options.form) {
      body = options.form;
    }
    const response = await fetch(new URL(path, this.baseUrl), {
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
    return { status: response.status, headers: response.headers, json, text, bytes };
  }
}

/** Build a multipart body; fields go first so `role` precedes `file`. */
export function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; bytes: Uint8Array },
  extras: Array<{ field: string; name: string; type: string; bytes: Uint8Array }> = []
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append('file', new Blob([file.bytes as BlobPart], { type: file.type }), file.name);
  for (const extra of extras)
    form.append(extra.field, new Blob([extra.bytes as BlobPart], { type: extra.type }), extra.name);
  return form;
}

/** Tiny valid media so uploads pass the server's magic-byte sniffing. */
export const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
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
