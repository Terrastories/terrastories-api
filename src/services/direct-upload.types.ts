/**
 * Storage-side contract of the direct multipart media upload (#286).
 *
 * A session is persisted as a small JSON journal at
 * `<tenant>/.multipart/<id>.json`. The journal doubles as the restart-safe
 * abort record: the Workers storage adapter and the erasure sweep already read
 * `{ key, uploadId }` from `.multipart/*.json` objects to abort an upload,
 * and the orphan sweeper deletes a journal (which aborts the upload) once it
 * ages past its grace window.
 */

export interface DirectUploadSession {
  v: 1;
  id: string;
  /** Final tenant-scoped storage key (same scheme as `POST /v2/media`). */
  key: string;
  /** Backend upload id (R2 multipart id, or the session id for `api` mode). */
  uploadId: string;
  mode: 'presigned' | 'api';
  actorId: number;
  communityId: number | null;
  fileId: string;
  originalName: string;
  mimeType: string;
  byteSize: number;
  /** Client-declared SHA-256 of the whole file (hex). */
  sha256: string;
  partSize: number;
  /** Client-declared SHA-256 (hex) of each part, in part order. */
  partSha256: string[];
  /** Raw binding fields (role, ownerType, ownerId, metadata) re-checked at completion. */
  bindingFields: Record<string, string>;
  createdAt: number;
  expiresAt: number;
}

export type NewDirectUploadSession = Omit<
  DirectUploadSession,
  'uploadId' | 'mode'
>;

export interface DirectUploadPartTarget {
  partNumber: number;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  size: number;
}

/** Failure classes the service maps to HTTP statuses. */
export class DirectUploadError extends Error {
  constructor(
    readonly kind:
      | 'invalid_parts'
      /** Backend says the upload was already completed or no longer exists. */
      | 'already_completed'
      | 'checksum'
      | 'size'
      | 'erasing'
      | 'wrong_mode'
      | 'part_length'
      | 'part_checksum'
      | 'part_number',
    message: string = kind
  ) {
    super(message);
    this.name = 'DirectUploadError';
  }
}

export interface DirectUploadAdapter {
  readonly mode: 'presigned' | 'api';
  /**
   * True when completion hashes the assembled bytes against the declared
   * whole-file SHA-256 (Node). False on Workers, where the digest cannot be
   * recomputed within the Free CPU budget, so it must not be stored as a
   * verified `File.checksum`.
   */
  readonly verifiesWholeFile: boolean;
  /** Persist the session journal and create the backend upload. */
  create(session: NewDirectUploadSession): Promise<DirectUploadSession>;
  load(tenantPrefix: string, id: string): Promise<DirectUploadSession | null>;
  partTargets(
    session: DirectUploadSession,
    context: { origin: string; now: Date; ttlSeconds: number }
  ): Promise<DirectUploadPartTarget[]>;
  /** `api` mode only: accept one part through this API. */
  putPart?(
    session: DirectUploadSession,
    partNumber: number,
    body: ReadableStream<Uint8Array>,
    options: { contentLength: number; sha256: string }
  ): Promise<{ etag: string }>;
  /** Assemble the object at `session.key`; returns its stored size. */
  complete(
    session: DirectUploadSession,
    parts: ReadonlyArray<{ partNumber: number; etag: string }>
  ): Promise<{ size: number }>;
  /** Rewrite the journal (extended expiry after re-issuing part targets). */
  update(session: DirectUploadSession): Promise<void>;
  /** Drop the journal (and any staged parts) after a finished session. */
  discard(session: DirectUploadSession): Promise<void>;
  /**
   * Abort the backend upload and drop the journal. Never deletes the final
   * object: an upload that already completed is left to the orphan sweeper,
   * which checks for a `files` row (an abort racing a completion must not
   * remove committed bytes).
   */
  abort(session: DirectUploadSession): Promise<void>;
}

/** Absolute ceiling on a session, however often part URLs are re-issued. */
export const DIRECT_UPLOAD_MAX_LIFETIME_SECONDS = 12 * 60 * 60;
/** Completion still succeeds this long after `expiresAt`. */
export const DIRECT_UPLOAD_COMPLETE_GRACE_SECONDS = 15 * 60;

export const directUploadJournalKey = (tenantPrefix: string, id: string) =>
  `${tenantPrefix}/.multipart/${id}.json`;

export function parseDirectUploadSession(
  raw: unknown
): DirectUploadSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<DirectUploadSession>;
  if (
    s.v !== 1 ||
    typeof s.id !== 'string' ||
    typeof s.key !== 'string' ||
    typeof s.uploadId !== 'string' ||
    (s.mode !== 'presigned' && s.mode !== 'api') ||
    typeof s.actorId !== 'number' ||
    typeof s.fileId !== 'string' ||
    typeof s.originalName !== 'string' ||
    typeof s.mimeType !== 'string' ||
    typeof s.byteSize !== 'number' ||
    typeof s.sha256 !== 'string' ||
    typeof s.partSize !== 'number' ||
    !Array.isArray(s.partSha256) ||
    typeof s.createdAt !== 'number' ||
    typeof s.expiresAt !== 'number' ||
    !s.bindingFields ||
    typeof s.bindingFields !== 'object'
  ) {
    return null;
  }
  return s as DirectUploadSession;
}

/** Size of part `partNumber` (1-based) for an upload of `byteSize` bytes. */
export function directUploadPartSize(
  byteSize: number,
  partSize: number,
  partNumber: number
): number {
  const count = Math.ceil(byteSize / partSize);
  return partNumber < count ? partSize : byteSize - partSize * (count - 1);
}

export const hexToBase64 = (hex: string): string => {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
};
