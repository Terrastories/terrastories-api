import { open, realpath } from 'node:fs/promises';
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
  };
}
