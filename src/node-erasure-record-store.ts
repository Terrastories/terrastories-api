import { mkdir, readFile, readdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ErasureRecordSchema,
  type ErasureRecord,
  type ErasureRecordStore,
} from './services/erasure-record-store.js';

/** Operator supplies a dedicated directory EXCLUDED from whole-state backups. */
export async function createNodeErasureRecordStore(
  directory: string
): Promise<ErasureRecordStore> {
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const persist = async (filename: string, record: ErasureRecord) => {
    const tmp = path.join(root, `.tmp-${randomUUID()}`);
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, filename);
    const dir = await open(root, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  };
  return {
    async list() {
      const names = (await readdir(root))
        .filter((n) => /^[1-9][0-9]*-(pending|completed)\.json$/.test(n))
        .sort();
      const records = new Map<number, ErasureRecord>();
      for (const name of names) {
        const record = ErasureRecordSchema.parse(
          JSON.parse(await readFile(path.join(root, name), 'utf8'))
        );
        const previous = records.get(record.communityId);
        if (!previous || record.completedAt !== null)
          records.set(record.communityId, record);
      }
      return [...records.values()].sort(
        (a, b) => a.communityId - b.communityId
      );
    },
    async write(raw) {
      const record = ErasureRecordSchema.parse(raw);
      const filename = path.join(
        root,
        `${record.communityId}-${record.completedAt ? 'completed' : 'pending'}.json`
      );
      await persist(filename, record);
      // Remove actor metadata from the pending version as well after completion.
      if (record.completedAt !== null) {
        const pending = path.join(root, `${record.communityId}-pending.json`);
        await persist(pending, {
          ...record,
          requestingActorId: null,
          completedAt: null,
          outcome: 'pending',
        });
      }
    },
  };
}
