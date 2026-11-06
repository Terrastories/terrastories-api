import { afterEach, describe, expect, test } from 'vitest';
import { FileRepository } from '../../src/repositories/file.repository.js';
import { UserRepository } from '../../src/repositories/user.repository.js';
import { testDb } from '../helpers/database.js';

describe('FileRepository legacy list policy', () => {
  afterEach(async () => {
    await testDb.teardown();
  });

  test('ignores removed elder-only filtering while preserving metadata and tenant scoping', async () => {
    const db = await testDb.setup();
    const fixtures = await testDb.seedTestData();
    const communityId = fixtures.communities[0].id;
    const otherCommunityId = fixtures.communities[1].id;
    const repository = new FileRepository(db);
    const user = await new UserRepository(db).create({
      email: 'file-policy@example.test',
      passwordHash: 'test-password-hash',
      firstName: 'File',
      lastName: 'Policy',
      communityId,
    });
    const otherUser = await new UserRepository(db).create({
      email: 'other-file-policy@example.test',
      passwordHash: 'test-password-hash',
      firstName: 'Other',
      lastName: 'Policy',
      communityId: otherCommunityId,
    });
    const createFile = (path: string, tenant: number, elderOnly: boolean) =>
      repository.create({
        filename: path,
        originalName: path,
        path,
        url: `https://example.test/${path}`,
        mimeType: 'audio/mpeg',
        size: 123,
        communityId: tenant,
        uploadedBy: tenant === communityId ? user.id : otherUser.id,
        culturalRestrictions: JSON.stringify({ elderOnly }),
      });

    const elder = await createFile('elder.mp3', communityId, true);
    const ordinary = await createFile('ordinary.mp3', communityId, false);
    await createFile('other-tenant.mp3', otherCommunityId, true);

    // SPEC-V2 §§2/11: elder-only policy is DROP. This compatibility input
    // cannot alter the list; legacy stored values remain available as evidence.
    for (const elderOnly of [true, false]) {
      const result = await repository.findByCommunity(communityId, {
        culturalRestrictions: { elderOnly },
        orderBy: 'filename',
        orderDirection: 'asc',
      });
      expect(result.data.map((file) => file.id)).toEqual([
        elder.id,
        ordinary.id,
      ]);
      expect(result.meta.total).toBe(2);
      expect(result.data[0].culturalRestrictions).toBe(
        JSON.stringify({ elderOnly: true })
      );
      expect(result.data[1].culturalRestrictions).toBe(
        JSON.stringify({ elderOnly: false })
      );
    }
  });
});
