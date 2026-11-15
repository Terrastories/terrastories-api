import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  validStorageKey,
  type FoundationStorage,
} from './services/hono-foundation.service.js';

export async function createLocalStorage(
  directory: string,
  openFile = open
): Promise<FoundationStorage> {
  const root = await realpath(directory);

  const resolveAuthorizedPath = async (
    key: string,
    createParentDirs: boolean
  ): Promise<{ targetPath: string; tenantRoot: string } | null> => {
    if (!validStorageKey(key)) return null;
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
  };
}
