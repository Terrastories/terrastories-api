/**
 * Presigned R2 multipart adapter for the Workers profile (#286).
 *
 * Create, complete and abort use the R2 binding (no network credentials and no
 * S3 round trips from the Worker); only the per-part `UploadPart` URLs are
 * presigned with the R2 S3 API credentials, locally, using Web Crypto. Part
 * bytes therefore never pass through the Worker: that sidesteps the Workers
 * Free 100 MB request-body ceiling and its CPU budget.
 *
 * Integrity: each part URL signs the part's exact `Content-Length` and the
 * client-declared `x-amz-checksum-sha256`, so R2 enforces both outside Worker
 * CPU. The Worker cannot cheaply re-hash a 500 MiB object (a streaming SHA-256
 * would exceed the 10 ms Free CPU budget), so the whole-file digest stays
 * client-attested on this path; size equality and the 8 KiB type sniff are
 * verified server-side at completion.
 */

import type { R2Bucket } from '@cloudflare/workers-types';
import { createSigV4Presigner } from '../shared/utils/sigv4-presign.js';
import { erasureFenceKey, validStorageKey } from './hono-foundation.service.js';
import {
  DirectUploadError,
  directUploadJournalKey,
  directUploadPartSize,
  hexToBase64,
  parseDirectUploadSession,
  type DirectUploadAdapter,
  type DirectUploadSession,
} from './direct-upload.types.js';

export interface R2DirectUploadConfig {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Read R2 S3 credentials from Worker bindings; partial config disables the feature. */
export function r2DirectUploadConfigFrom(env: {
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}): R2DirectUploadConfig | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucketName = env.R2_BUCKET_NAME?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucketName) {
    return null;
  }
  if (!/^[0-9a-zA-Z-]{1,64}$/.test(accountId)) return null;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) return null;
  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

const ALREADY_GONE =
  /no\s*such\s*upload|not\s*found|does\s*not\s*exist|already\s*(completed|aborted)|10024/i;

const tenantOf = (session: Pick<DirectUploadSession, 'key'>) =>
  session.key.split('/').slice(0, 2).join('/');

export function createR2DirectUploads(
  bucket: R2Bucket,
  config: R2DirectUploadConfig
): DirectUploadAdapter {
  const communityIdOf = (key: string) =>
    key.startsWith('communities/') ? Number(key.split('/')[1]) : null;
  const assertWritable = async (key: string) => {
    const communityId = communityIdOf(key);
    if (
      communityId !== null &&
      (await bucket.head(erasureFenceKey(communityId)))
    ) {
      throw new DirectUploadError('erasing', 'Community storage is erasing');
    }
  };
  const abortBackend = async (session: DirectUploadSession) => {
    try {
      await bucket.resumeMultipartUpload(session.key, session.uploadId).abort();
    } catch (error) {
      if (!ALREADY_GONE.test(error instanceof Error ? error.message : '')) {
        throw error;
      }
    }
  };

  return {
    mode: 'presigned',
    async create(input) {
      if (!validStorageKey(input.key)) throw new Error('Invalid storage key');
      await assertWritable(input.key);
      const upload = await bucket.createMultipartUpload(input.key, {
        httpMetadata: { contentType: input.mimeType },
      });
      const session: DirectUploadSession = {
        ...input,
        mode: 'presigned',
        uploadId: upload.uploadId,
      };
      try {
        // The journal is the restart-safe abort record (sweeper and erasure
        // read it); a fence that raced creation aborts the upload here.
        await bucket.put(
          directUploadJournalKey(tenantOf(session), session.id),
          JSON.stringify(session)
        );
        await assertWritable(input.key);
      } catch (error) {
        await upload.abort().catch(() => {});
        await bucket
          .delete(directUploadJournalKey(tenantOf(session), session.id))
          .catch(() => {});
        throw error;
      }
      return session;
    },
    async load(tenantPrefix, id) {
      const journal = await bucket.get(
        directUploadJournalKey(tenantPrefix, id)
      );
      if (!journal) return null;
      try {
        const session = parseDirectUploadSession(await journal.json());
        // A journal must describe an upload under its own tenant prefix.
        if (
          !session ||
          session.id !== id ||
          session.mode !== 'presigned' ||
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
      const presigner = await createSigV4Presigner(
        {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
          region: 'auto',
          service: 's3',
        },
        context.now
      );
      const host = `${config.accountId}.r2.cloudflarestorage.com`;
      return Promise.all(
        session.partSha256.map(async (sha256, index) => {
          const partNumber = index + 1;
          const size = directUploadPartSize(
            session.byteSize,
            session.partSize,
            partNumber
          );
          const checksum = hexToBase64(sha256);
          const url = await presigner.presign({
            method: 'PUT',
            host,
            path: `/${config.bucketName}/${session.key}`,
            query: {
              partNumber: String(partNumber),
              uploadId: session.uploadId,
            },
            signedHeaders: {
              'content-length': String(size),
              'x-amz-checksum-sha256': checksum,
            },
            expiresSeconds: context.ttlSeconds,
            now: context.now,
          });
          return {
            partNumber,
            method: 'PUT' as const,
            url,
            headers: { 'x-amz-checksum-sha256': checksum },
            size,
          };
        })
      );
    },
    async complete(session, parts) {
      const count = Math.ceil(session.byteSize / session.partSize);
      const numbers = new Set(parts.map((p) => p.partNumber));
      if (
        parts.length !== count ||
        numbers.size !== count ||
        [...numbers].some((n) => n < 1 || n > count)
      ) {
        throw new DirectUploadError('invalid_parts');
      }
      await assertWritable(session.key);
      try {
        await bucket
          .resumeMultipartUpload(session.key, session.uploadId)
          .complete(
            [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ partNumber: p.partNumber, etag: p.etag }))
          );
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        // A retry after a crash between complete and the row insert finds the
        // upload already completed; the object check below decides.
        if (!ALREADY_GONE.test(message)) {
          throw new DirectUploadError('invalid_parts');
        }
      }
      const head = await bucket.head(session.key);
      if (!head) throw new DirectUploadError('invalid_parts');
      try {
        await assertWritable(session.key);
      } catch (error) {
        await bucket.delete(session.key).catch(() => {});
        throw error;
      }
      return { size: head.size };
    },
    async discard(session) {
      await bucket.delete(
        directUploadJournalKey(tenantOf(session), session.id)
      );
    },
    async abort(session) {
      await abortBackend(session);
      await bucket.delete(
        directUploadJournalKey(tenantOf(session), session.id)
      );
    },
  };
}
