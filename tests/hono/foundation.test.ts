import { it, expect } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runHonoFoundationContract } from '../../scripts/hono-foundation-contract.js';
import { createLocalStorage } from '../../src/node-storage.js';

it('enforces the shared foundation contract against migrated SQLite', async () => {
  const sqlite = new Sqlite(':memory:');
  sqlite.pragma('foreign_keys=ON');
  const db = drizzle(sqlite);
  try {
    migrate(db, { migrationsFolder: 'src/db/migrations' });
    await runHonoFoundationContract(db);
  } finally {
    sqlite.close();
  }
});

it('keeps resolved storage bytes inside their authorized tenant', async () => {
  const root = await mkdtemp(`${tmpdir()}/hono-storage-`);
  await mkdir(`${root}/communities/1`, { recursive: true });
  await mkdir(`${root}/communities/2`, { recursive: true });
  await writeFile(`${root}/communities/1/own`, 'own');
  await writeFile(`${root}/communities/2/private`, 'private');
  await symlink('../2/private', `${root}/communities/1/escape`);
  await writeFile(`${root}/communities/1/unreadable`, 'private', { mode: 0 });
  const storage = await createLocalStorage(root);
  const own = await storage.read('communities/1/own');
  expect(own).toBeInstanceOf(ReadableStream);
  expect(await new Response(own as ReadableStream).text()).toBe('own');
  expect(await storage.read('communities/1/escape')).toBeNull();
  expect(await storage.read('communities/1/../2/private')).toBeNull();
  await expect(storage.read('communities/1/unreadable')).rejects.toMatchObject({
    code: 'EACCES',
  });
});
