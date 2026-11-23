/**
 * Streaming `multipart/form-data` parser over Web `ReadableStream<Uint8Array>`.
 *
 * Avoids `Request.formData()` so uploaded file bytes never buffer in full inside
 * Cloudflare Workers isolates or Node memory. Enforces total request byte caps
 * incrementally and surfaces backpressure from downstream storage writes.
 */

export class MultipartStreamError extends Error {
  constructor(
    public readonly code:
      | 'invalid_content_type'
      | 'payload_too_large'
      | 'malformed_multipart'
      | 'field_too_large'
      | 'missing_file'
      | 'duplicate_file'
      | 'too_many_fields'
      | 'too_many_files',
    message: string
  ) {
    super(message);
    this.name = 'MultipartStreamError';
  }
}

export interface MultipartImportParseResult<TCsvResult, TMediaResult> {
  fields: Map<string, string>;
  csvResult: TCsvResult;
  mediaResults: TMediaResult[];
}

export interface MultipartFilePart<TResult> {
  name: string;
  filename: string;
  contentType: string;
  fieldsSoFar: ReadonlyMap<string, string>;
  stream: ReadableStream<Uint8Array>;
  finish: (result: TResult) => void;
}

export interface MultipartParseResult<TResult> {
  fields: Map<string, string>;
  fileResult: TResult;
}

const MAX_BOUNDARY_LENGTH = 70;
const MAX_PART_HEADER_BYTES = 8 * 1024;
const MAX_TEXT_FIELDS = 16;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export function extractMultipartBoundary(
  contentTypeHeader: string | undefined
): string | null {
  if (!contentTypeHeader) return null;
  const parts = contentTypeHeader.split(';');
  const mediaType = parts[0]?.trim().toLowerCase();
  if (mediaType !== 'multipart/form-data') {
    return null;
  }
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i]!.trim();
    const eqIdx = param.indexOf('=');
    if (eqIdx === -1) continue;
    const key = param.slice(0, eqIdx).trim().toLowerCase();
    if (key !== 'boundary') continue;
    let value = param.slice(eqIdx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (
      value.length === 0 ||
      value.length > MAX_BOUNDARY_LENGTH ||
      /[\r\n\0]/.test(value)
    ) {
      return null;
    }
    return value;
  }
  return null;
}

function indexOfBytes(
  haystack: Uint8Array,
  needle: Uint8Array,
  fromIndex = 0
): number {
  const limit = haystack.byteLength - needle.byteLength;
  if (limit < fromIndex) return -1;
  const first = needle[0]!;
  for (let i = fromIndex; i <= limit; i++) {
    if (haystack[i] !== first) continue;
    let matched = true;
    for (let j = 1; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return i;
  }
  return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function parsePartHeaders(raw: string): {
  name: string;
  filename?: string;
  contentType: string;
} {
  const lines = raw.split('\r\n');
  let name: string | undefined;
  let filename: string | undefined;
  let contentType = '';

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const headerName = line.slice(0, colon).trim().toLowerCase();
    const headerValue = line.slice(colon + 1).trim();
    if (headerName === 'content-disposition') {
      const segments = headerValue.split(';');
      if (segments[0]?.trim().toLowerCase() !== 'form-data') {
        throw new MultipartStreamError(
          'malformed_multipart',
          'Invalid Content-Disposition'
        );
      }
      for (let i = 1; i < segments.length; i++) {
        const seg = segments[i]!.trim();
        const eq = seg.indexOf('=');
        if (eq === -1) continue;
        const paramName = seg.slice(0, eq).trim().toLowerCase();
        let paramVal = seg.slice(eq + 1).trim();
        if (
          paramVal.startsWith('"') &&
          paramVal.endsWith('"') &&
          paramVal.length >= 2
        ) {
          paramVal = paramVal.slice(1, -1);
        }
        if (paramName === 'name') {
          name = paramVal;
        } else if (paramName === 'filename') {
          filename = paramVal;
        }
      }
    } else if (headerName === 'content-type') {
      contentType = headerValue;
    }
  }

  if (!name) {
    throw new MultipartStreamError(
      'malformed_multipart',
      'Missing part field name'
    );
  }
  return { name, filename, contentType };
}

class BufferedMultipartReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private eof = false;
  private totalRead = 0;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly maxRequestBytes: number
  ) {
    this.reader = stream.getReader();
  }

  private async pullMore(): Promise<boolean> {
    if (this.eof) return false;
    const { done, value } = await this.reader.read();
    if (done || !value) {
      this.eof = true;
      return false;
    }
    this.totalRead += value.byteLength;
    if (this.totalRead > this.maxRequestBytes) {
      await this.cancel();
      throw new MultipartStreamError(
        'payload_too_large',
        'Request exceeds maximum upload limit'
      );
    }
    if (value.byteLength > 0) {
      this.buffer = concatBytes(this.buffer, value);
    }
    return true;
  }

  async consumeInitialBoundary(boundary: string): Promise<void> {
    const startDelim = encoder.encode(`--${boundary}`);
    while (this.buffer.byteLength < startDelim.byteLength + 2) {
      if (!(await this.pullMore())) {
        throw new MultipartStreamError(
          'malformed_multipart',
          'Empty or truncated multipart body'
        );
      }
    }
    // Some clients send leading CRLF before first boundary.
    if (this.buffer[0] === 0x0d && this.buffer[1] === 0x0a) {
      this.buffer = this.buffer.subarray(2);
      while (this.buffer.byteLength < startDelim.byteLength + 2) {
        if (!(await this.pullMore())) {
          throw new MultipartStreamError(
            'malformed_multipart',
            'Truncated multipart body'
          );
        }
      }
    }
    const idx = indexOfBytes(this.buffer, startDelim);
    if (idx !== 0) {
      throw new MultipartStreamError(
        'malformed_multipart',
        'Invalid multipart opening boundary'
      );
    }
    const after = startDelim.byteLength;
    if (this.buffer[after] === 0x2d && this.buffer[after + 1] === 0x2d) {
      throw new MultipartStreamError(
        'missing_file',
        'Empty multipart form payload'
      );
    }
    if (this.buffer[after] !== 0x0d || this.buffer[after + 1] !== 0x0a) {
      throw new MultipartStreamError(
        'malformed_multipart',
        'Invalid boundary terminator'
      );
    }
    this.buffer = this.buffer.subarray(after + 2);
  }

  async readPartHeaders(): Promise<{
    name: string;
    filename?: string;
    contentType: string;
  }> {
    const headerEnd = encoder.encode('\r\n\r\n');
    while (true) {
      const idx = indexOfBytes(this.buffer, headerEnd);
      if (idx !== -1) {
        if (idx > MAX_PART_HEADER_BYTES) {
          throw new MultipartStreamError(
            'malformed_multipart',
            'Part headers exceed limit'
          );
        }
        const raw = decoder.decode(this.buffer.subarray(0, idx));
        this.buffer = this.buffer.subarray(idx + headerEnd.byteLength);
        return parsePartHeaders(raw);
      }
      if (this.buffer.byteLength > MAX_PART_HEADER_BYTES) {
        throw new MultipartStreamError(
          'malformed_multipart',
          'Part headers exceed limit'
        );
      }
      if (!(await this.pullMore())) {
        throw new MultipartStreamError(
          'malformed_multipart',
          'Unexpected end of multipart headers'
        );
      }
    }
  }

  /**
   * Pulls the next chunk belonging to the current part, returning `eof` + `isLastPart`
   * when `\r\n--<boundary>(\r\n|--)` is reached. Never buffers whole part bodies.
   */
  async readPartChunk(boundaryDelim: Uint8Array): Promise<{
    chunk: Uint8Array;
    partDone: boolean;
    streamDone: boolean;
  }> {
    const reserve = boundaryDelim.byteLength + 2;
    let searchFrom = 0;

    while (true) {
      const idx = indexOfBytes(this.buffer, boundaryDelim, searchFrom);
      if (idx !== -1) {
        while (this.buffer.byteLength < idx + reserve) {
          if (!(await this.pullMore())) {
            throw new MultipartStreamError(
              'malformed_multipart',
              'Truncated multipart boundary'
            );
          }
        }
        const b1 = this.buffer[idx + boundaryDelim.byteLength]!;
        const b2 = this.buffer[idx + boundaryDelim.byteLength + 1]!;
        if (b1 === 0x0d && b2 === 0x0a) {
          const chunk = this.buffer.subarray(0, idx);
          this.buffer = this.buffer.subarray(idx + reserve);
          return { chunk, partDone: true, streamDone: false };
        }
        if (b1 === 0x2d && b2 === 0x2d) {
          const chunk = this.buffer.subarray(0, idx);
          this.buffer = this.buffer.subarray(idx + reserve);
          return { chunk, partDone: true, streamDone: true };
        }
        searchFrom = idx + boundaryDelim.byteLength;
        continue;
      }

      if (this.buffer.byteLength > reserve) {
        const safeLen = this.buffer.byteLength - reserve;
        const chunk = this.buffer.slice(0, safeLen);
        this.buffer = this.buffer.subarray(safeLen);
        return { chunk, partDone: false, streamDone: false };
      }

      if (!(await this.pullMore())) {
        throw new MultipartStreamError(
          'malformed_multipart',
          'Unexpected EOF inside multipart body'
        );
      }
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => {});
  }

  release(): void {
    this.reader.releaseLock();
  }
}

/**
 * Streaming multipart parser for bounded CSV imports: accepts text fields,
 * one required `file` CSV part, and 0..N `media` file parts without buffering
 * the entire multipart request in memory.
 */
export async function parseMultipartImportStream<TCsvResult, TMediaResult>(
  body: ReadableStream<Uint8Array> | null,
  contentTypeHeader: string | undefined,
  options: {
    maxRequestBytes: number;
    maxMediaFiles: number;
    maxTextFields?: number;
    maxTextFieldBytes?: number;
    onCsvPart: (part: MultipartFilePart<TCsvResult>) => Promise<void>;
    onMediaPart: (part: MultipartFilePart<TMediaResult>) => Promise<void>;
  }
): Promise<MultipartImportParseResult<TCsvResult, TMediaResult>> {
  const boundary = extractMultipartBoundary(contentTypeHeader);
  if (!boundary) {
    throw new MultipartStreamError(
      'invalid_content_type',
      'Expected multipart/form-data with boundary'
    );
  }
  if (!body) {
    throw new MultipartStreamError(
      'malformed_multipart',
      'Missing request body'
    );
  }

  const maxTextFields = options.maxTextFields ?? MAX_TEXT_FIELDS;
  const maxTextFieldBytes = options.maxTextFieldBytes ?? 64 * 1024;
  const reader = new BufferedMultipartReader(body, options.maxRequestBytes);
  const boundaryDelim = encoder.encode(`\r\n--${boundary}`);
  const fields = new Map<string, string>();
  let hasCsv = false;
  let hasCsvResult = false;
  let csvResult!: TCsvResult;
  const mediaResults: TMediaResult[] = [];

  try {
    await reader.consumeInitialBoundary(boundary);
    while (true) {
      const headers = await reader.readPartHeaders();
      if (
        headers.filename === undefined &&
        headers.name !== 'file' &&
        headers.name !== 'media'
      ) {
        if (fields.size >= maxTextFields) {
          throw new MultipartStreamError(
            'too_many_fields',
            'Too many form fields'
          );
        }
        if (fields.has(headers.name)) {
          throw new MultipartStreamError(
            'malformed_multipart',
            `Duplicate form field: ${headers.name}`
          );
        }
        const chunks: Uint8Array[] = [];
        let fieldBytes = 0;
        let streamDone = false;
        while (true) {
          const {
            chunk,
            partDone,
            streamDone: done,
          } = await reader.readPartChunk(boundaryDelim);
          fieldBytes += chunk.byteLength;
          if (fieldBytes > maxTextFieldBytes) {
            throw new MultipartStreamError(
              'field_too_large',
              'Form field exceeds maximum size'
            );
          }
          if (chunk.byteLength > 0) chunks.push(chunk);
          if (partDone) {
            streamDone = done;
            break;
          }
        }
        const merged =
          chunks.length === 1
            ? chunks[0]!
            : chunks.reduce((acc, c) => concatBytes(acc, c), new Uint8Array(0));
        fields.set(headers.name, decoder.decode(merged));
        if (streamDone) break;
        continue;
      }

      if (headers.filename === undefined) {
        throw new MultipartStreamError(
          'malformed_multipart',
          'File part must include a filename'
        );
      }

      if (headers.name !== 'file' && headers.name !== 'media') {
        throw new MultipartStreamError(
          'malformed_multipart',
          'Unexpected file part field name'
        );
      }

      const isCsv = headers.name === 'file';
      if (isCsv && hasCsv) {
        throw new MultipartStreamError(
          'duplicate_file',
          'Only one CSV file part is allowed'
        );
      }
      if (!isCsv && mediaResults.length >= options.maxMediaFiles) {
        throw new MultipartStreamError(
          'too_many_files',
          `At most ${options.maxMediaFiles} staged media files are allowed`
        );
      }

      let partFinished = false;
      let reachedStreamEnd = false;
      const partStream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (partFinished) {
            controller.close();
            return;
          }
          try {
            const { chunk, partDone, streamDone } =
              await reader.readPartChunk(boundaryDelim);
            if (chunk.byteLength > 0) {
              controller.enqueue(chunk);
            }
            if (partDone) {
              partFinished = true;
              reachedStreamEnd = streamDone;
              controller.close();
            }
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel() {
          partFinished = true;
          await reader.cancel();
        },
      });

      if (isCsv) {
        hasCsv = true;
        await options.onCsvPart({
          name: headers.name,
          filename: headers.filename,
          contentType: headers.contentType,
          fieldsSoFar: fields,
          stream: partStream,
          finish: (result) => {
            hasCsvResult = true;
            csvResult = result;
          },
        });
      } else {
        let hasMediaResult = false;
        let mediaResult!: TMediaResult;
        await options.onMediaPart({
          name: headers.name,
          filename: headers.filename,
          contentType: headers.contentType,
          fieldsSoFar: fields,
          stream: partStream,
          finish: (result) => {
            hasMediaResult = true;
            mediaResult = result;
          },
        });
        if (hasMediaResult) {
          mediaResults.push(mediaResult);
        }
      }

      if (!partFinished) {
        const drain = partStream.getReader();
        try {
          while (!(await drain.read()).done) {
            // Drain remaining unread part bytes cleanly up to boundary.
          }
        } finally {
          drain.releaseLock();
        }
      }

      if (reachedStreamEnd) break;
    }

    if (!hasCsv || !hasCsvResult) {
      throw new MultipartStreamError('missing_file', 'Missing uploaded CSV');
    }
    return { fields, csvResult, mediaResults };
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.release();
  }
}
