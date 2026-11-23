/**
 * `api`-mode direct upload adapter (#286): parts are streamed through this
 * API into the profile's own storage (Node local disk). Same routes and
 * contract as the presigned R2 mode, so a client has one upload path; the only
 * difference is that part targets point back at this API.
 *
 * Unlike R2 multipart, the assembled object is hashed (native `node:crypto`
 * inside storage `put`) against the client's whole-file SHA-256, and every
 * part against its declared digest, so integrity is fully verified.
 */

import {
  StorageChecksumMismatchError,
  validStorageKey,
  type FoundationStorage,
} from './hono-foundation.service.js';
import {
  DirectUploadError,
  directUploadJournalKey,
  directUploadPartSize,
  hexToBase64,
  parseDirectUploadSession,
  type DirectUploadAdapter,
  type DirectUploadSession,
} from './direct-upload.types.js';

async function readAll(
  body: Uint8Array | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const tenantOf = (session: Pick<DirectUploadSession, 'key'>) =>
  session.key.split('/').slice(0, 2).join('/');
const partKey = (session: DirectUploadSession, partNumber: number) =>
  `${tenantOf(session)}/.multipart/${session.id}.part-${partNumber}`;

export function createStorageDirectUploads(
  storage: FoundationStorage
): DirectUploadAdapter | null {
  if (!storage.put || !storage.delete) return null;
  const put = storage.put.bind(storage);
  const remove = storage.delete.bind(storage);
  const partCount = (session: DirectUploadSession) =>
    Math.ceil(session.byteSize / session.partSize);

  const dropParts = async (session: DirectUploadSession) => {
    for (let n = 1; n <= partCount(session); n++) {
      await remove(partKey(session, n)).catch(() => {});
    }
  };

  return {
    mode: 'api',
    verifiesWholeFile: true,
    async update(session) {
      await put(
        directUploadJournalKey(tenantOf(session), session.id),
        new TextEncoder().encode(JSON.stringify(session))
      );
    },
    async create(input) {
      const session: DirectUploadSession = {
        ...input,
        mode: 'api',
        uploadId: input.id,
      };
      await put(
        directUploadJournalKey(tenantOf(session), session.id),
        new TextEncoder().encode(JSON.stringify(session))
      );
      return session;
    },
    async load(tenantPrefix, id) {
      const stored = await storage.read(
        directUploadJournalKey(tenantPrefix, id)
      );
      if (!stored) return null;
      try {
        const session = parseDirectUploadSession(
          JSON.parse(new TextDecoder().decode(await readAll(stored.body)))
        );
        if (
          !session ||
          session.id !== id ||
          session.mode !== 'api' ||
          tenantOf(session) !== tenantPrefix ||
          !validStorageKey(session.key)
        ) {
          return null;
        }
        return session;
      } catch {
        return null;
      }
    },
    async partTargets(session, context) {
      return session.partSha256.map((sha256, index) => ({
        partNumber: index + 1,
        method: 'PUT' as const,
        url: `${context.origin}/v2/media/uploads/${session.id}/parts/${index + 1}`,
        headers: { 'x-amz-checksum-sha256': hexToBase64(sha256) },
        size: directUploadPartSize(
          session.byteSize,
          session.partSize,
          index + 1
        ),
      }));
    },
    async putPart(session, partNumber, body, options) {
      const expected = session.partSha256[partNumber - 1];
      if (!expected) throw new DirectUploadError('part_number');
      try {
        await put(partKey(session, partNumber), body, {
          sha256: expected,
          contentLength: options.contentLength,
        });
      } catch (error) {
        if (error instanceof StorageChecksumMismatchError)
          throw new DirectUploadError('part_checksum');
        throw error;
      }
      return { etag: expected };
    },
    async complete(session, parts) {
      const count = partCount(session);
      const byNumber = new Map(parts.map((p) => [p.partNumber, p.etag]));
      if (parts.length !== count || byNumber.size !== count) {
        throw new DirectUploadError('invalid_parts');
      }
      for (let n = 1; n <= count; n++) {
        const etag = byNumber.get(n)?.replace(/"/g, '');
        if (etag !== session.partSha256[n - 1]) {
          throw new DirectUploadError('invalid_parts');
        }
      }
      // Probe every part before streaming so a missing part is a clean 400.
      for (let n = 1; n <= count; n++) {
        const probe = await storage.read(partKey(session, n), {
          start: 0,
          end: 0,
        });
        if (!probe) throw new DirectUploadError('invalid_parts');
        if (!(probe.body instanceof Uint8Array)) {
          await probe.body.cancel().catch(() => {});
        }
        if (
          probe.size !==
          directUploadPartSize(session.byteSize, session.partSize, n)
        ) {
          throw new DirectUploadError('invalid_parts');
        }
      }
      let next = 1;
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      const assembled = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              if (!reader) {
                if (next > count) {
                  controller.close();
                  return;
                }
                const part = await storage.read(partKey(session, next));
                next += 1;
                if (!part) throw new DirectUploadError('invalid_parts');
                reader =
                  part.body instanceof Uint8Array
                    ? new ReadableStream<Uint8Array>({
                        start(c) {
                          c.enqueue(part.body as Uint8Array);
                          c.close();
                        },
                      }).getReader()
                    : part.body.getReader();
              }
              const { done, value } = await reader.read();
              if (done) {
                reader = null;
                continue;
              }
              if (value && value.byteLength > 0) {
                controller.enqueue(value);
                return;
              }
            }
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader?.cancel(reason).catch(() => {});
        },
      });
      try {
        const stored = await put(session.key, assembled, {
          contentType: session.mimeType,
          sha256: session.sha256,
          contentLength: session.byteSize,
        });
        return { size: stored.size };
      } catch (error) {
        if (error instanceof StorageChecksumMismatchError)
          throw new DirectUploadError('checksum');
        throw error;
      }
    },
    async discard(session) {
      await dropParts(session);
      await remove(directUploadJournalKey(tenantOf(session), session.id));
    },
    async abort(session) {
      await dropParts(session);
      await remove(directUploadJournalKey(tenantOf(session), session.id));
    },
  };
}
