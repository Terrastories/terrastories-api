import { randomUUID } from 'node:crypto';
import {
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
  ORPHAN_SWEEP_CURSOR_KEY,
  validStorageKey,
  validSystemStorageKey,
  type FoundationStorage,
} from './services/hono-foundation.service.js';

const DEFAULT_LIST_LIMIT = 200;

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
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
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
        await rename(tmpPath, targetPath);
        return { size };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(tmpPath).catch(() => {});
        throw error;
      }
    },

    async delete(key) {
      if (!validStorageKey(key)) return;
      try {
        const filename = await realpath(path.resolve(root, key));
        const tenantRoot = path.resolve(
          root,
          key.split('/').slice(0, 2).join('/')
        );
        if (!filename.startsWith(tenantRoot + path.sep)) return;
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
        // The sweeper's cursor is system state, never sweepable bytes.
        .filter((key) => key !== ORPHAN_SWEEP_CURSOR_KEY)
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
