import { access, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { getConfig } from '../../../src/shared/config/index.js';
import { createFixture } from '../../../scripts/qa/sqlite-fixture.js';
import * as personas from '../../../scripts/qa/personas/index.js';
import { extractSignedSessionCookie } from '../../helpers/session-cookie.js';

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
    const before = (await readdir(uploadRoot))
      .filter((name) => name.startsWith('persona-fixture-'))
      .sort();
    const failingJourneys = vi
      .spyOn(personas, 'createJourneys')
      .mockImplementationOnce(() => {
        throw new Error('fixture setup regression');
      });
    try {
      await expect(createFixture()).rejects.toThrow('fixture setup regression');
    } finally {
      failingJourneys.mockRestore();
    }
    const after = (await readdir(uploadRoot))
      .filter((name) => name.startsWith('persona-fixture-'))
      .sort();
    expect(after).toEqual(before);
  });
});
