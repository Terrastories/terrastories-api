import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** fsync a regular file or directory so its contents/entries are durable. */
export async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** fsync a directory and every directory beneath it (not the files in it). */
export async function fsyncDirectoryTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await fsyncDirectoryTree(join(root, entry.name));
    }
  }
  await fsyncPath(root);
}
