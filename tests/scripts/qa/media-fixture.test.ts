import {
  access,
  readFile,
  mkdtemp,
  rmdir,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getConfig } from '../../../src/shared/config/index.js';
import { createFixture } from '../../../scripts/qa/sqlite-fixture.js';
import * as personas from '../../../scripts/qa/personas/index.js';
import { extractSignedSessionCookie } from '../../helpers/session-cookie.js';

// The ESM namespace of a node: builtin is not configurable, so mkdtemp is
// observed through a partial module mock instead of vi.spyOn.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

describe('persona media fixture evidence', () => {
  it('serves seeded readable bytes and denies real foreign/held/unknown bytes', async () => {
    const fixture = await createFixture();
    const evidence = fixture.mediaEvidence;
    try {
      for (const file of [evidence.readable, ...evidence.unavailable]) {
        expect(await readFile(file.path)).toEqual(evidence.bytes);
      }
      const login = fixture.journeys.find(
        (journey) => journey.persona === 'viewer'
      )!.steps[0];
      const response = await fixture.handler(
        new Request('http://qa.invalid/api/v1/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(login.body),
        })
      );
      expect(response.status).toBe(200);
      const cookie = extractSignedSessionCookie(
        response.headers.getSetCookie()
      );
      const readable = await fixture.handler(
        new Request(`http://qa.invalid/api/v1/files/${evidence.readable.id}`, {
          headers: { cookie },
        })
      );
      expect(readable.status).toBe(200);
      expect(Buffer.from(await readable.arrayBuffer())).toEqual(evidence.bytes);
      for (const file of evidence.unavailable) {
        const unavailable = await fixture.handler(
          new Request(`http://qa.invalid/api/v1/files/${file.id}`, {
            headers: { cookie },
          })
        );
        expect(unavailable.status).toBe(404);
        // Bytes still exist: denial cannot be explained by a missing disk file.
        expect(await readFile(file.path)).toEqual(evidence.bytes);
      }
    } finally {
      await fixture.close();
    }
    await expect(access(evidence.directory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('removes only owned media when setup fails after creating the application', async () => {
    const uploadRoot = resolve(getConfig().fileUpload.uploadDir);
    const mkdtempMock = vi.mocked(mkdtemp);
    const untouched = await mkdtemp(
      join(uploadRoot, 'persona-fixture-control-')
    );
    const sentinel = join(untouched, 'sentinel');
    await writeFile(sentinel, 'preserve');
    // Drop the control directory's call so only the fixture's call is recorded.
    mkdtempMock.mockClear();
    const failingJourneys = vi
      .spyOn(personas, 'createJourneys')
      .mockImplementationOnce(() => {
        throw new Error('fixture setup regression');
      });
    try {
      await expect(createFixture()).rejects.toThrow('fixture setup regression');
      expect(mkdtempMock).toHaveBeenCalledTimes(1);
      const owned = await mkdtempMock.mock.results[0]!.value;
      expect(owned).toBeDefined();
      await expect(access(owned)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(sentinel, 'utf8')).toBe('preserve');
    } finally {
      failingJourneys.mockRestore();
      mkdtempMock.mockClear();
      await unlink(sentinel);
      await rmdir(untouched);
    }
  });
});
