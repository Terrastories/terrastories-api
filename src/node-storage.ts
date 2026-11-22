import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  validStorageKey,
  validLegacyStorageKey,
  validSystemStorageKey,
  erasureFenceKey,
  type FoundationStorage,
} from './services/hono-foundation.service.js';

const DEFAULT_LIST_LIMIT = 200;

// Shared by adapters for the same filesystem root, including request and cron
// instances. Fencing cancels stalled streams and awaits handle closure.
const activeLocalWrites = new Map<
  string,
  Set<{
    cancel: () => void;
    settled: Promise<void>;
  }>
>();

/** Recursively collect regular-file storage keys under a directory. */
async function walkStorageDir(
  root: string,
  directory: string,
  out: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkStorageDir(root, absolute, out);
    } else if (entry.isFile()) {
      // Dot-prefixed names are listed on purpose: an interrupted upload leaves
      // a `.tmp-*` file beside its target, and the orphan sweeper must still be
      // able to see and remove those bytes.
      out.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
}

export async function createLocalStorage(
  directory: string,
  openFile = open
): Promise<FoundationStorage> {
  const root = await realpath(directory);

  const resolveAuthorizedPath = async (
    key: string,
    createParentDirs: boolean
  ): Promise<{ targetPath: string; tenantRoot: string } | null> => {
    if (!validStorageKey(key) && !validSystemStorageKey(key)) return null;
    const tenantRoot = path.resolve(root, key.split('/').slice(0, 2).join('/'));
    const targetPath = path.resolve(root, key);
    if (!targetPath.startsWith(tenantRoot + path.sep)) return null;
    if (createParentDirs) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      const resolvedDir = await realpath(path.dirname(targetPath));
      const resolvedTenant = await realpath(tenantRoot);
      if (
        resolvedDir !== resolvedTenant &&
        !resolvedDir.startsWith(resolvedTenant + path.sep)
      ) {
        return null;
      }
    }
    return { targetPath, tenantRoot };
  };

  /**
   * Read a system object by absolute key. Only the storage layer itself calls
   * this (the sweeper's cursor); media serving keeps the tenant-key guard.
   */
  const readSystemObject = async (key: string): Promise<Uint8Array | null> => {
    if (!validSystemStorageKey(key)) return null;
    try {
      const filename = await realpath(path.resolve(root, key));
      if (!filename.startsWith(root + path.sep)) return null;
      const handle = await openFile(filename, 'r');
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of handle.createReadStream()) {
          chunks.push(chunk as Uint8Array);
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      } finally {
        await handle.close().catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  const writeSystemObject = async (
    key: string,
    bytes: Uint8Array
  ): Promise<void> => {
    if (!validSystemStorageKey(key)) throw new Error('Invalid system key');
    const targetPath = path.resolve(root, key);
    const dir = path.dirname(targetPath);
    await mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.tmp-${randomUUID()}`);
    const handle = await openFile(tmpPath, 'w', 0o600);
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset
        );
        offset += bytesWritten;
      }
      await handle.close();
      await rename(tmpPath, targetPath);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  };

  return {
    async fenceCommunity(communityId) {
      await writeSystemObject(erasureFenceKey(communityId), new Uint8Array(0));
      const writers = [
        ...(activeLocalWrites.get(`${root}:${communityId}`) ?? []),
      ];
      for (const writer of writers) writer.cancel();
      await Promise.all(writers.map((writer) => writer.settled));
    },
    async read(key, range) {
      if (!validStorageKey(key)) return null;
      try {
        const filename = await realpath(path.resolve(root, key));
        const tenantRoot = path.resolve(
          root,
          key.split('/').slice(0, 2).join('/')
        );
        if (!filename.startsWith(tenantRoot + path.sep)) return null;
        const file = await openFile(filename, 'r');
        try {
          const stat = await file.stat();
          const stream = range
            ? file.createReadStream({ start: range.start, end: range.end })
            : file.createReadStream();
          return {
            body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
            size: stat.size,
          };
        } catch (error) {
          await file.close().catch(() => {});
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },

    async put(key, body) {
      const writerKey = `${root}:${key.startsWith('communities/') ? key.split('/')[1] : 'system'}`;
      let cancelled = false;
      let readerToCancel: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let settle!: () => void;
      const writer = {
        cancel: () => {
          cancelled = true;
          void readerToCancel?.cancel().catch(() => {});
        },
        settled: new Promise<void>((resolve) => {
          settle = resolve;
        }),
      };
      const writers = activeLocalWrites.get(writerKey) ?? new Set();
      activeLocalWrites.set(writerKey, writers);
      writers.add(writer);
      try {
        const assertWritable = async () => {
          if (cancelled) throw new Error('Community storage is erasing');
          if (
            key.startsWith('communities/') &&
            (await readSystemObject(erasureFenceKey(Number(key.split('/')[1]))))
          )
            throw new Error('Community storage is erasing');
        };
        await assertWritable();
        const resolved = await resolveAuthorizedPath(key, true);
        if (!resolved) {
          throw new Error('Invalid storage key');
        }
        const { targetPath } = resolved;
        const tmpPath = path.join(
          path.dirname(targetPath),
          `.tmp-${randomUUID()}`
        );
        const handle = await openFile(tmpPath, 'w', 0o600);
        let size = 0;
        try {
          // The temporary inode precedes this fence check. Once fencing lands,
          // a sweep can unlink it and every later rename fails, even if a writer
          // had already passed its last fence check before the sweep.
          await assertWritable();
          if (body instanceof Uint8Array) {
            let offset = 0;
            while (offset < body.byteLength) {
              const { bytesWritten } = await handle.write(
                body,
                offset,
                body.byteLength - offset
              );
              offset += bytesWritten;
            }
            size = body.byteLength;
          } else {
            const reader = body.getReader();
            readerToCancel = reader;
            if (cancelled) await reader.cancel();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await assertWritable();
                if (value && value.byteLength > 0) {
                  let offset = 0;
                  while (offset < value.byteLength) {
                    const { bytesWritten } = await handle.write(
                      value,
                      offset,
                      value.byteLength - offset
                    );
                    offset += bytesWritten;
                  }
                  size += value.byteLength;
                }
              }
            } finally {
              reader.releaseLock();
            }
          }
          await handle.close();
          await assertWritable();
          await rename(tmpPath, targetPath);
          return { size };
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(tmpPath).catch(() => {});
          throw error;
        }
      } finally {
        writers.delete(writer);
        if (!writers.size) activeLocalWrites.delete(writerKey);
        settle();
      }
    },

    async delete(key) {
      if (!validStorageKey(key) && !validLegacyStorageKey(key)) return;
      try {
        const tenantRoot = path.resolve(
          root,
          key
            .split('/')
            .slice(0, validLegacyStorageKey(key) ? 1 : 2)
            .join('/')
        );
        const target = path.resolve(root, key);
        // Resolve only the parent, never the final component, so a symlink
        // key is unlinked itself and its target is untouched.
        const parent = await realpath(path.dirname(target));
        if (parent !== tenantRoot && !parent.startsWith(tenantRoot + path.sep))
          throw new Error('Invalid deletion path');
        const filename = path.join(parent, path.basename(target));
        const info = await lstat(filename);
        // A directory key addresses no object; nothing to delete.
        if (info.isDirectory()) return;
        await unlink(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
    },

    async list(options) {
      const prefix = options?.prefix ?? '';
      const limit = options?.limit ?? DEFAULT_LIST_LIMIT;
      // Enumerate all keys once, filter by prefix, sort for a stable cursor.
      const all: string[] = [];
      await walkStorageDir(root, root, all);
      const matched = all
        .filter((key) => key.startsWith(prefix))
        // The sweeper's system state (cursor, restore hold) is never sweepable bytes.
        .filter((key) => !validSystemStorageKey(key))
        .sort()
        .filter((key) =>
          options?.startAfter ? key > options.startAfter : true
        );
      const page = matched.slice(0, limit);
      const truncated = matched.length > page.length;
      const entries = await Promise.all(
        page.map(async (key) => ({
          key,
          // A filesystem restore can recreate bytes with a young mtime; ctime
          // catches both clocks, so recently restored bytes are never
          // mistaken for garbage.
          uploaded: await stat(path.join(root, key))
            .then((s) => (s.ctime > s.mtime ? s.ctime : s.mtime))
            .catch(() => new Date(0)),
        }))
      );
      return {
        entries,
        truncated,
        nextStartAfter: truncated ? page[page.length - 1] : undefined,
      };
    },

    getSystemObject: (key) => readSystemObject(key),

    putSystemObject: (key, bytes) => writeSystemObject(key, bytes),
  };
}
