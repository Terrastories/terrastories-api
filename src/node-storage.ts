/** Local adapter boundary; the Hono request path depends only on read(key). */
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FoundationStorage } from './services/hono-foundation.service.js';

export async function createLocalStorage(
  directory: string
): Promise<FoundationStorage> {
  const root = await realpath(directory);
  return {
    async read(key) {
      if (
        !/^communities\/[1-9][0-9]*\//.test(key) ||
        key
          .split('/')
          .some(
            (part) =>
              !part || part === '.' || part === '..' || part.includes('\\')
          )
      )
        return null;
      try {
        const filename = await realpath(path.resolve(root, key));
        const tenantRoot = path.resolve(
          root,
          key.split('/').slice(0, 2).join('/')
        );
        if (!filename.startsWith(tenantRoot + path.sep)) return null;
        return await readFile(filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}
