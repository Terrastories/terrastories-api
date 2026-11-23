/**
 * Raw-body `POST /v2/media` request builder (#249): the file bytes are the
 * request body; filename/role/owner/metadata ride in the query string, the
 * declared type in Content-Type and the client digest in x-content-sha256.
 */
import { createHash } from 'node:crypto';
import { StorageChecksumMismatchError } from '../../src/services/hono-foundation.service.js';

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** In-memory test storages mimic the adapter contract: verify `sha256` on put. */
export function assertPutSha256(
  bytes: Uint8Array,
  expected: string | undefined
): void {
  if (expected !== undefined && sha256Hex(bytes) !== expected) {
    throw new StorageChecksumMismatchError();
  }
}

export interface RawUploadOptions {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  /** Upload parameters sent as query params (role, ownerType, ownerId, metadata). */
  fields?: Record<string, string>;
  /** Override the digest header (default: the real SHA-256); null omits it. */
  sha256?: string | null;
  /** Omit Content-Length (chunked upload). */
  omitContentLength?: boolean;
}

export function rawUploadRequest(options: RawUploadOptions): {
  search: string;
  headers: Record<string, string>;
  body: Uint8Array;
} {
  const params = new URLSearchParams({
    filename: options.filename,
    ...(options.fields ?? {}),
  });
  const headers: Record<string, string> = {
    'content-type': options.contentType,
  };
  if (options.sha256 !== null) {
    headers['x-content-sha256'] = options.sha256 ?? sha256Hex(options.bytes);
  }
  if (!options.omitContentLength) {
    headers['content-length'] = String(options.bytes.byteLength);
  }
  return { search: `?${params.toString()}`, headers, body: options.bytes };
}
