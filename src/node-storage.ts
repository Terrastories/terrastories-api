import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import {
  validStorageKey,
  type FoundationStorage,
} from './services/hono-foundation.service.js';

export async function createLocalStorage(
  directory: string
): Promise<FoundationStorage> {
  const root = await realpath(directory);
  return {
    async read(key) {
      if (!validStorageKey(key)) return null;
      try {
        const filename = await realpath(path.resolve(root, key));
        const tenantRoot = path.resolve(
          root,
          key.split('/').slice(0, 2).join('/')
        );
        if (!filename.startsWith(tenantRoot + path.sep)) return null;
        return Readable.toWeb(createReadStream(filename));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}
