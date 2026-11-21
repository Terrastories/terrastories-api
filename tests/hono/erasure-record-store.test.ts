import { it, expect } from 'vitest';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNodeErasureRecordStore } from '../../src/node-erasure-record-store.js';
import {
  redactErasureActor,
  verifyErasureRestorePoint,
  type ErasureRecord,
} from '../../src/services/erasure-record-store.js';

it('persists excluded erasure records across adapter recreation and keeps completion after a stale pending write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tsapi-erasure-records-'));
  const store = await createNodeErasureRecordStore(root);
  const record: ErasureRecord = {
    communityId: 1,
    requestId: crypto.randomUUID(),
    requestingActorId: 2,
    requestedAt: '2026-11-21T00:00:00.000Z',
    completedAt: null,
    outcome: 'pending',
    archiveCustody: {
      custodianType: 'steward',
      custodianUserId: 3,
      retentionUntil: '2026-11-21T00:00:00.000Z',
      destructionAttestationRef: 'attestation-ref',
    },
  };
  await store.write(record);
  await expect(verifyErasureRestorePoint(store, new Date())).rejects.toThrow();
  const completed = {
    ...record,
    outcome: 'completed' as const,
    completedAt: '2026-11-21T01:00:00.000Z',
  };
  await store.write(completed);
  await store.write(record);
  const restarted = await createNodeErasureRecordStore(root);
  expect(await restarted.list()).toEqual([completed]);
  await expect(
    verifyErasureRestorePoint(restarted, new Date('2026-11-21T00:59:59.999Z'))
  ).rejects.toThrow();
  await verifyErasureRestorePoint(restarted, new Date(completed.completedAt));
  await restarted.write(
    redactErasureActor(completed, new Date('2026-12-21T01:00:00.000Z'))
  );
  for (const name of ['1-pending.json', '1-completed.json']) {
    expect(
      JSON.parse(await readFile(path.join(root, name), 'utf8'))
        .requestingActorId
    ).toBeNull();
    expect((await stat(path.join(root, name))).mode & 0o777).toBe(0o600);
  }
});
