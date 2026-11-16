/**
 * Shared Range-capable, sandbox-headered media byte streaming helper used by both
 * public and authenticated V2 media download endpoints (§6.7, §9).
 */

import {
  validStorageKey,
  type FoundationStorage,
} from '../../services/hono-foundation.service.js';
import { INTERNAL_ERROR_BODY } from '../../services/public-communities.service.js';

export type ParsedByteRange =
  | { kind: 'none' }
  | { kind: 'unsatisfiable' }
  | { kind: 'slice'; start: number; end: number };

export function parseByteRange(
  rangeHeader: string | undefined,
  totalLength: number
): ParsedByteRange {
  if (!rangeHeader) {
    return { kind: 'none' };
  }
  const trimmed = rangeHeader.trim();
  if (!trimmed || !trimmed.toLowerCase().startsWith('bytes=')) {
    return { kind: 'none' };
  }
  const spec = trimmed.slice('bytes='.length).trim();
  if (!spec) {
    return { kind: 'unsatisfiable' };
  }
  const parts = spec.split(',').map((part) => part.trim());
  if (parts.length > 1) {
    // RFC 9110 §14.2: server MAY ignore multi-range requests and return 200 full representation.
    const looksLikeMultiRange = parts.every((part) =>
      /^(\d+-\d*|-\d+)$/.test(part)
    );
    return looksLikeMultiRange ? { kind: 'none' } : { kind: 'unsatisfiable' };
  }
  const match = /^(\d*)-(\d*)$/.exec(parts[0] ?? '');
  if (!match) {
    return { kind: 'unsatisfiable' };
  }
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') {
    return { kind: 'unsatisfiable' };
  }
  if (totalLength <= 0) {
    return { kind: 'unsatisfiable' };
  }

  if (startStr === '') {
    const suffixLength = Number(endStr);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, totalLength - suffixLength);
    return { kind: 'slice', start, end: totalLength - 1 };
  }

  const start = Number(startStr);
  if (!Number.isSafeInteger(start) || start < 0 || start >= totalLength) {
    return { kind: 'unsatisfiable' };
  }

  if (endStr === '') {
    return { kind: 'slice', start, end: totalLength - 1 };
  }

  const requestedEnd = Number(endStr);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) {
    return { kind: 'unsatisfiable' };
  }

  return {
    kind: 'slice',
    start,
    end: Math.min(requestedEnd, totalLength - 1),
  };
}

export function toResponseBody(
  data: Uint8Array | ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> {
  if (data instanceof ReadableStream) {
    return data;
  }
  return data as Uint8Array<ArrayBuffer>;
}

export interface StreamableMediaFile {
  storageKey: string;
  expectedPrefix: string;
  mimeType: string;
  byteSize: number;
}

export async function streamAuthorizedMediaResponse(
  storage: FoundationStorage,
  file: StreamableMediaFile,
  rangeHeader: string | undefined
): Promise<Response | null> {
  if (
    !validStorageKey(file.storageKey) ||
    !file.storageKey.startsWith(file.expectedPrefix)
  ) {
    return null;
  }

  const totalLength = file.byteSize;
  if (!Number.isSafeInteger(totalLength) || totalLength < 0) {
    return null;
  }

  const range = parseByteRange(rangeHeader, totalLength);

  const baseHeaders = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  };

  if (range.kind === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes */${totalLength}`,
      },
    });
  }

  if (range.kind === 'slice') {
    const stored = await storage.read(file.storageKey, {
      start: range.start,
      end: range.end,
    });
    if (!stored) {
      return null;
    }
    if (!Number.isSafeInteger(stored.size) || stored.size !== totalLength) {
      if (stored.body instanceof ReadableStream) {
        await stored.body.cancel().catch(() => {});
      }
      return new Response(JSON.stringify(INTERNAL_ERROR_BODY), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }
    const contentLength = range.end - range.start + 1;
    return new Response(toResponseBody(stored.body), {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Type': file.mimeType,
        'Content-Disposition': 'attachment',
        'Content-Range': `bytes ${range.start}-${range.end}/${stored.size}`,
        'Content-Length': String(contentLength),
      },
    });
  }

  const stored = await storage.read(file.storageKey);
  if (!stored) {
    return null;
  }
  if (!Number.isSafeInteger(stored.size) || stored.size !== totalLength) {
    if (stored.body instanceof ReadableStream) {
      await stored.body.cancel().catch(() => {});
    }
    return new Response(JSON.stringify(INTERNAL_ERROR_BODY), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  }

  return new Response(toResponseBody(stored.body), {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type': file.mimeType,
      'Content-Disposition': 'attachment',
      'Content-Length': String(stored.size),
    },
  });
}
