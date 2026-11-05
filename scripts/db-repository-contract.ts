/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared repository contract, executed unchanged against SQLite and
 * PostgreSQL by scripts/test-db-backend.ts so both backends must satisfy the
 * same application-level behavior.
 */
import assert from 'node:assert/strict';

/**
 * Assert a timestamp read back from a repository is a real, usable Date:
 * `instanceof Date` alone also accepts `new Date(NaN)`.
 */
export function assertValidDate(value: unknown, label: string): void {
  assert.ok(
    value instanceof Date && Number.isFinite(value.getTime()),
    `${label} must be a Date with a finite time, got ${
      value instanceof Date ? value.toISOString() : typeof value
    }`
  );
}

export async function runRepositoryContract(database: unknown): Promise<void> {
  const { CommunityRepository } = await import(
    '../src/repositories/community.repository.js'
  );
  const { PlaceRepository } = await import(
    '../src/repositories/place.repository.js'
  );
  const { UserRepository } = await import(
    '../src/repositories/user.repository.js'
  );
  const { SpeakerRepository } = await import(
    '../src/repositories/speaker.repository.js'
  );
  const { FileRepository } = await import(
    '../src/repositories/file.repository.js'
  );

  const communities = new CommunityRepository(database as any);
  const places = new PlaceRepository(database as any);
  const users = new UserRepository(database as any);
  const speakers = new SpeakerRepository(database as any);
  const files = new FileRepository(database as any);

  const community = await communities.create({
    name: 'Repository Contract Community',
    country: 'BR',
    beta: true,
  });
  assert.equal(community.country, 'BR');
  // Compatibility-only V1 field (not canonical per SPEC-V2 §6.1); asserted to keep the coexistence surface stable.
  assert.equal(community.beta, true);
  assertValidDate(community.createdAt, 'communities.create createdAt');

  await assert.rejects(
    communities.create({
      name: 'Duplicate Slug Community',
      slug: community.slug,
    }),
    /slug already exists/i
  );

  const first = await places.create({
    name: 'A Nearby Public',
    communityId: community.id,
    latitude: -1.4558,
    longitude: -48.4902,
    mediaUrls: ['https://example.test/nearby.jpg'],
    isRestricted: false,
  });
  const second = await places.create({
    name: 'B Nearby Restricted',
    communityId: community.id,
    latitude: -1.456,
    longitude: -48.4901,
    isRestricted: true,
  });
  await places.create({
    name: 'C Far Public',
    communityId: community.id,
    latitude: -3.119,
    longitude: -60.0217,
    isRestricted: false,
  });

  assert.deepEqual(first.mediaUrls, ['https://example.test/nearby.jpg']);
  assertValidDate(first.createdAt, 'places.create createdAt');

  const publicNear = await places.searchNear({
    communityId: community.id,
    latitude: -1.4558,
    longitude: -48.4902,
    radiusKm: 1,
    page: 1,
    limit: 20,
  });
  assert.deepEqual(
    publicNear.data.map((place) => place.id),
    [first.id]
  );

  const allNear = await places.searchNear({
    communityId: community.id,
    latitude: -1.4558,
    longitude: -48.4902,
    radiusKm: 1,
    page: 1,
    limit: 20,
    includeRestricted: true,
  });
  assert.deepEqual(
    new Set(allNear.data.map((place) => place.id)),
    new Set([first.id, second.id])
  );

  const bounded = await places.searchInBounds({
    communityId: community.id,
    north: -1.45,
    south: -1.46,
    east: -48.48,
    west: -48.5,
    page: 1,
    limit: 20,
    includeRestricted: true,
  });
  assert.deepEqual(
    new Set(bounded.data.map((place) => place.id)),
    new Set([first.id, second.id])
  );

  const ordered = await places.getByCommunity(community.id, {
    page: 1,
    limit: 20,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.deepEqual(
    ordered.data.map((place) => place.name),
    ['A Nearby Public', 'B Nearby Restricted', 'C Far Public']
  );

  const firstPage = await places.getByCommunity(community.id, {
    page: 1,
    limit: 2,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  const secondPage = await places.getByCommunity(community.id, {
    page: 2,
    limit: 2,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.pages, 2);
  assert.deepEqual(
    firstPage.data.map((place) => place.name),
    ['A Nearby Public', 'B Nearby Restricted']
  );
  assert.deepEqual(
    secondPage.data.map((place) => place.name),
    ['C Far Public']
  );

  const countryResults = await communities.search({
    country: 'BR',
    beta: true,
  });
  assert.ok(countryResults.some((row) => row.id === community.id));

  const datelineCommunity = await communities.create({
    name: 'Dateline Radius Community',
  });
  const datelineEast = await places.create({
    name: 'Dateline East',
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: 179.9,
  });
  const datelineWest = await places.create({
    name: 'Dateline West',
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: -179.9,
  });
  await places.create({
    name: 'Dateline Far',
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: 170,
  });
  const datelineResults = await places.searchNear({
    communityId: datelineCommunity.id,
    latitude: 0,
    longitude: 179.95,
    radiusKm: 30,
    page: 1,
    limit: 10,
    includeRestricted: true,
  });
  assert.deepEqual(
    new Set(datelineResults.data.map((place) => place.id)),
    new Set([datelineEast.id, datelineWest.id])
  );

  const polarCommunity = await communities.create({
    name: 'Polar Radius Community',
  });
  const polarNear = await places.create({
    name: 'Polar Near',
    communityId: polarCommunity.id,
    latitude: 89.9,
    longitude: 120,
  });
  await places.create({
    name: 'Polar Far',
    communityId: polarCommunity.id,
    latitude: 88,
    longitude: 0,
  });
  const polarResults = await places.searchNear({
    communityId: polarCommunity.id,
    latitude: 89.9,
    longitude: 0,
    radiusKm: 30,
    page: 1,
    limit: 10,
    includeRestricted: true,
  });
  assert.deepEqual(
    polarResults.data.map((place) => place.id),
    [polarNear.id]
  );

  // S1: ASCII case folding must behave identically on both backends, so
  // lowercase and uppercase search terms both find mixed-case data.
  const riverCommunity = await communities.create({
    name: 'River People Community',
  });
  for (const query of ['river', 'RIVER']) {
    const riverResults = await communities.search({ query });
    assert.ok(
      riverResults.some((row) => row.id === riverCommunity.id),
      `communities.search({ query: '${query}' }) must find River People Community`
    );
  }

  const ana = await users.create({
    email: 'a.silva@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Ana',
    lastName: 'Silva',
    communityId: riverCommunity.id,
  });
  assertValidDate(ana.createdAt, 'users.create createdAt');
  for (const search of ['ana', 'ANA']) {
    const anaResults = await users.findByCommunity(riverCommunity.id, {
      search,
    });
    assert.ok(
      anaResults.data.some((row) => row.id === ana.id),
      `users.findByCommunity({ search: '${search}' }) must find Ana by first name`
    );
  }

  const riverSpeaker = await speakers.create({
    name: 'River Guide Tui',
    communityId: riverCommunity.id,
  });
  for (const query of ['river', 'RIVER']) {
    const speakerResults = await speakers.searchByName(
      riverCommunity.id,
      query,
      { page: 1, limit: 10 }
    );
    assert.equal(speakerResults.total, 1);
    assert.ok(
      speakerResults.data.some((row) => row.id === riverSpeaker.id),
      `speakers.searchByName('${query}') must find River Guide Tui`
    );
  }

  // File rows are plain database records here, so the search contract can be
  // exercised without real file storage.
  const riverFile = await files.create({
    filename: 'River-Ceremony.mp3',
    originalName: 'River Ceremony.MP3',
    path: 'contract/river-ceremony.mp3',
    url: 'https://example.test/river-ceremony.mp3',
    mimeType: 'audio/mpeg',
    size: 2048,
    communityId: riverCommunity.id,
    uploadedBy: ana.id,
  });
  for (const search of ['river', 'RIVER', 'ceremony', 'CEREMONY']) {
    const fileResults = await files.findByCommunity(riverCommunity.id, {
      search,
    });
    assert.ok(
      fileResults.data.some((row) => row.id === riverFile.id),
      `files.findByCommunity({ search: '${search}' }) must find the river file by filename/originalName`
    );
  }

  // S2: name ordering must be collation-independent byte order on both
  // backends, not the server locale's alphabetical order.
  const orderingCommunity = await communities.create({
    name: 'Byte Order Community',
  });
  for (const name of ['cherry', 'Banana', 'Álamo', 'apple', 'Zebra']) {
    await places.create({
      name,
      communityId: orderingCommunity.id,
      latitude: 0,
      longitude: 0,
    });
  }
  const byteOrderAsc = await places.getByCommunity(orderingCommunity.id, {
    page: 1,
    limit: 20,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.deepEqual(
    byteOrderAsc.data.map((place) => place.name),
    ['Banana', 'Zebra', 'apple', 'cherry', 'Álamo']
  );
  const byteOrderDesc = await places.getByCommunity(orderingCommunity.id, {
    page: 1,
    limit: 20,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'desc',
  });
  assert.deepEqual(
    byteOrderDesc.data.map((place) => place.name),
    ['Álamo', 'cherry', 'apple', 'Zebra', 'Banana']
  );

  // Equal names must fall back to ascending id so pages stay deterministic.
  const twinCommunity = await communities.create({
    name: 'Twin Order Community',
  });
  const twinFirst = await places.create({
    name: 'Twin',
    communityId: twinCommunity.id,
    latitude: 1,
    longitude: 1,
  });
  const twinSecond = await places.create({
    name: 'Twin',
    communityId: twinCommunity.id,
    latitude: 2,
    longitude: 2,
  });
  const twinAsc = await places.getByCommunity(twinCommunity.id, {
    page: 1,
    limit: 20,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.deepEqual(
    twinAsc.data.map((place) => place.id),
    [twinFirst.id, twinSecond.id]
  );

  // S3: coordinates must round-trip exactly through every read path; SQLite
  // REAL and PostgreSQL double precision are both 64-bit IEEE 754.
  const precisionCommunity = await communities.create({
    name: 'Coordinate Precision Community',
  });
  await places.create({
    name: 'Precision Point',
    communityId: precisionCommunity.id,
    latitude: 45.123456,
    longitude: -123.456789,
  });
  const precisionListed = await places.getByCommunity(precisionCommunity.id, {
    page: 1,
    limit: 10,
    includeRestricted: true,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.equal(precisionListed.data.length, 1);
  assert.equal(precisionListed.data[0].latitude, 45.123456);
  assert.equal(precisionListed.data[0].longitude, -123.456789);
  assertValidDate(
    precisionListed.data[0].createdAt,
    'places.getByCommunity createdAt'
  );
  const precisionById = await places.getById(precisionListed.data[0].id);
  if (!precisionById) {
    throw new Error('places.getById must return the precision place');
  }
  assert.equal(precisionById.latitude, 45.123456);
  assert.equal(precisionById.longitude, -123.456789);

  // Issue #178: these compatibility repositories must select their schema
  // from the supplied database, just like every other repository above.
  const { StoryRepository } = await import(
    '../src/repositories/story.repository.js'
  );
  const { ThemesRepository } = await import(
    '../src/repositories/themes.repository.js'
  );
  const stories = new StoryRepository(database as any);
  const themes = new ThemesRepository(database as any);
  const storyPlace = await places.create({
    name: 'Story Contract Place',
    communityId: riverCommunity.id,
    latitude: 45.123456,
    longitude: -123.456789,
  });
  const relatedStory = await stories.create({
    title: 'River Journey',
    description: 'Mixed Case Ceremony',
    communityId: riverCommunity.id,
    createdBy: ana.id,
    tags: ['Forest', 'ÁRVORE'],
    placeIds: [storyPlace.id],
    speakerIds: [riverSpeaker.id],
    speakerRoles: ['narrator'],
    interviewLocationId: storyPlace.id,
    interviewerId: riverSpeaker.id,
  });
  const assertStoryRelations = (story: typeof relatedStory | null) => {
    assert.ok(story);
    assert.deepEqual(
      story.places.map((row) => row.id),
      [storyPlace.id]
    );
    assert.equal(story.places[0].latitude, 45.123456);
    assert.equal(story.places[0].longitude, -123.456789);
    assert.deepEqual(
      story.speakers.map((row) => row.id),
      [riverSpeaker.id]
    );
    assert.equal(story.speakers[0].storyRole, 'narrator');
    assert.equal(story.interviewLocation?.id, storyPlace.id);
    assert.equal(story.interviewer?.id, riverSpeaker.id);
    assertValidDate(story.createdAt, 'stories relations createdAt');
  };
  assertStoryRelations(relatedStory);
  assertStoryRelations(await stories.findByIdWithRelations(relatedStory.id));
  assert.equal(
    (await stories.findById(relatedStory.id))?.title,
    'River Journey'
  );
  const secondStory = await stories.create({
    title: 'Second Journey',
    communityId: riverCommunity.id,
    createdBy: ana.id,
    tags: ['Water'],
  });
  const thirdStory = await stories.create({
    title: 'Third Journey',
    communityId: riverCommunity.id,
    createdBy: ana.id,
    tags: ['Forest'],
  });
  const updatedStory = await stories.update(secondStory.id, {
    title: 'Updated Journey',
    description: 'Fresh Description',
    tags: ['Water', 'Forest'],
    placeIds: [storyPlace.id],
    speakerIds: [riverSpeaker.id],
    speakerRoles: ['interviewee'],
  });
  assert.equal(updatedStory?.title, 'Updated Journey');
  assert.deepEqual(updatedStory?.tags, ['Water', 'Forest']);
  assert.deepEqual(
    updatedStory?.places.map((row) => row.id),
    [storyPlace.id]
  );
  assert.equal(updatedStory?.speakers[0].storyRole, 'interviewee');
  assertValidDate(updatedStory?.updatedAt, 'stories.update updatedAt');
  const storyPage1 = await stories.findMany(
    { communityId: riverCommunity.id },
    { page: 1, limit: 2 }
  );
  const storyPage2 = await stories.findMany(
    { communityId: riverCommunity.id },
    { page: 2, limit: 2 }
  );
  assert.equal(storyPage1.total, 3);
  assert.equal(storyPage2.total, 3);
  assert.equal(storyPage1.totalPages, 2);
  assert.deepEqual(
    storyPage1.data.map((row) => row.id),
    [thirdStory.id, secondStory.id]
  );
  assert.deepEqual(
    storyPage2.data.map((row) => row.id),
    [relatedStory.id]
  );
  assertStoryRelations(storyPage2.data[0]);
  for (const search of ['river', 'RIVER', 'ceremony', 'CEREMONY']) {
    const found = await stories.findMany(
      { communityId: riverCommunity.id, search },
      { page: 1, limit: 10 }
    );
    assert.deepEqual(
      found.data.map((row) => row.id),
      [relatedStory.id]
    );
    assert.equal(found.total, 1);
  }
  // SPEC-V2 §6.3: application-normalized match-any, with totals computed
  // after filtering, never a backend-specific JSON containment operation.
  const tagsPage1 = await stories.findMany(
    { communityId: riverCommunity.id, tags: ['missing', 'FOREST'] },
    { page: 1, limit: 2 }
  );
  const tagsPage2 = await stories.findMany(
    { communityId: riverCommunity.id, tags: ['missing', 'forest'] },
    { page: 2, limit: 2 }
  );
  assert.equal(tagsPage1.total, 3);
  assert.equal(tagsPage2.total, 3);
  assert.deepEqual(
    tagsPage1.data.map((row) => row.id),
    [thirdStory.id, secondStory.id]
  );
  assert.deepEqual(
    tagsPage2.data.map((row) => row.id),
    [relatedStory.id]
  );
  const unicodeTags = await stories.findMany(
    { communityId: riverCommunity.id, tags: ['árvore'] },
    { page: 1, limit: 10 }
  );
  assert.deepEqual(
    unicodeTags.data.map((row) => row.id),
    [relatedStory.id]
  );
  assert.equal(
    (
      await stories.findMany(
        { communityId: community.id, tags: ['Forest'] },
        { page: 1, limit: 10 }
      )
    ).total,
    0
  );
  assert.equal(
    await stories.validatePlacesInCommunity([storyPlace.id], community.id),
    false
  );
  assert.equal(
    await stories.validateSpeakersInCommunity(
      [riverSpeaker.id],
      riverCommunity.id
    ),
    true
  );
  assert.equal(
    await stories.validateSpeakersInCommunity([riverSpeaker.id], community.id),
    false
  );
  assert.equal(
    await stories.validateSpeakersInCommunity([2147483647], riverCommunity.id),
    false
  );
  assert.equal(
    await stories.validateSpeakersInCommunity([], riverCommunity.id),
    true
  );
  const clearedStory = await stories.update(secondStory.id, {
    placeIds: [],
    speakerIds: [],
  });
  assert.deepEqual(clearedStory?.places, []);
  assert.deepEqual(clearedStory?.speakers, []);

  // SPEC-V2 §§2/11 drops elder-only list policy on both backends;
  // compatibility filter input must not select or discard legacy metadata.
  const otherFileUser = await users.create({
    email: 'other-file-contract@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Other',
    lastName: 'Uploader',
    communityId: community.id,
  });
  const policyFileIds: string[] = [];
  for (const [name, tenant, uploader, elderOnly] of [
    ['Legacy Policy Elder', riverCommunity.id, ana.id, true],
    ['Legacy Policy Ordinary', riverCommunity.id, ana.id, false],
    ['Legacy Policy Foreign', community.id, otherFileUser.id, true],
  ] as const) {
    const file = await files.create({
      filename: name,
      originalName: name,
      path: `contract/${name}.mp3`,
      url: 'https://example.test/policy.mp3',
      mimeType: 'audio/mpeg',
      size: 123,
      communityId: tenant,
      uploadedBy: uploader,
      culturalRestrictions: JSON.stringify({ elderOnly }),
    });
    policyFileIds.push(file.id);
  }
  for (const elderOnly of [true, false]) {
    const result = await files.findByCommunity(riverCommunity.id, {
      search: 'Legacy Policy',
      culturalRestrictions: { elderOnly },
      orderBy: 'filename',
      orderDirection: 'asc',
    });
    assert.deepEqual(
      result.data.map((row) => row.id),
      policyFileIds.slice(0, 2)
    );
    assert.equal(result.meta.total, 2);
    // SQLite stores legacy metadata as text; PostgreSQL jsonb decodes it.
    // Compare the preserved values independently of the storage representation.
    for (const [index, expected] of [true, false].entries()) {
      const metadata = result.data[index].culturalRestrictions;
      assert.deepEqual(
        typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
        { elderOnly: expected }
      );
    }
  }

  // Multiple themes remain a coexistence-only surface (SPEC-V2 §6.6).
  const coordinates = {
    centerLat: 0,
    centerLong: -48.490201,
    swBoundaryLat: -1.455801,
    swBoundaryLong: -49.123456,
    neBoundaryLat: 1.123456,
    neBoundaryLong: -47.123456,
  };
  const assertCoordinates = (theme: any, expected = coordinates) => {
    assert.ok(theme);
    for (const key of Object.keys(expected) as Array<
      keyof typeof coordinates
    >) {
      assert.equal(
        theme[key],
        expected[key],
        `theme.${key} must round-trip as a number`
      );
      assert.equal(typeof theme[key], 'number');
    }
    assertValidDate(theme.createdAt, 'themes createdAt');
  };
  const coordinateTheme = await themes.create({
    name: 'River Map',
    description: 'Ceremony Map',
    active: true,
    communityId: riverCommunity.id,
    ...coordinates,
  });
  assertCoordinates(coordinateTheme);
  assertCoordinates(await themes.findById(coordinateTheme.id));
  assertCoordinates(
    await themes.findByIdWithCommunityCheck(
      coordinateTheme.id,
      riverCommunity.id
    )
  );
  assert.equal(
    await themes.findByIdWithCommunityCheck(coordinateTheme.id, community.id),
    null
  );
  assert.equal(
    await themes.existsInCommunity(coordinateTheme.id, community.id),
    false
  );
  assert.equal(
    await themes.updateByCommunity(coordinateTheme.id, community.id, {
      name: 'Forbidden',
    }),
    null
  );
  assert.equal(
    await themes.deleteByCommunity(coordinateTheme.id, community.id),
    false
  );
  const updatedCoordinates = {
    ...coordinates,
    centerLat: -1.123456,
    centerLong: 0,
  };
  assertCoordinates(
    await themes.update(coordinateTheme.id, updatedCoordinates),
    updatedCoordinates
  );
  await themes.create({
    name: 'River Inactive',
    communityId: riverCommunity.id,
    active: false,
  });
  const nullTheme = await themes.create({
    name: 'Other Active',
    communityId: riverCommunity.id,
    active: true,
  });
  for (const row of [nullTheme, await themes.findById(nullTheme.id)]) {
    for (const key of Object.keys(coordinates))
      assert.equal((row as any)[key], null);
  }
  assert.equal(
    await themes.countByCommunityId(riverCommunity.id, {
      activeOnly: true,
      searchTerm: 'RIVER',
    }),
    1
  );
  const themePage1 = await themes.findByCommunityId(riverCommunity.id, {
    page: 1,
    limit: 2,
    sortBy: 'name',
  });
  const themePage2 = await themes.findByCommunityId(riverCommunity.id, {
    page: 2,
    limit: 2,
    sortBy: 'name',
  });
  assert.equal(themePage1.total, 3);
  assert.equal(themePage2.total, 3);
  assert.equal(themePage1.pages, 2);
  assert.deepEqual(
    themePage1.data.map((row) => row.name),
    ['Other Active', 'River Inactive']
  );
  assert.deepEqual(
    themePage2.data.map((row) => row.id),
    [coordinateTheme.id]
  );
  assertCoordinates(themePage2.data[0], updatedCoordinates);
  for (const query of ['river', 'RIVER', 'ceremony', 'CEREMONY']) {
    const found = await themes.searchThemes(riverCommunity.id, {
      query,
      page: 1,
      limit: 10,
    });
    assert.equal(found.total, query.toLowerCase() === 'river' ? 2 : 1);
    assertCoordinates(
      found.data.find((row) => row.id === coordinateTheme.id),
      updatedCoordinates
    );
  }
  for (const rows of [
    await themes.findByCommunityId(riverCommunity.id),
    await themes.findActiveThemes(riverCommunity.id),
    await themes.searchByName(riverCommunity.id, 'RIVER'),
    await themes.searchByDescription(riverCommunity.id, 'CEREMONY'),
    await themes.searchActiveThemes(riverCommunity.id, 'RIVER'),
    (
      await themes.findByCommunityIdPaginated(riverCommunity.id, {
        page: 1,
        limit: 10,
      })
    ).themes,
  ])
    assertCoordinates(
      rows.find((row) => row.id === coordinateTheme.id),
      updatedCoordinates
    );

  const themeOrderCommunity = await communities.create({
    name: 'Theme Byte Order Community',
  });
  const themeOrderIds: number[] = [];
  for (const name of [
    'cherry',
    'Banana',
    'Álamo',
    'apple',
    'Zebra',
    'Twin',
    'Twin',
  ]) {
    const theme = await themes.create({
      name,
      communityId: themeOrderCommunity.id,
      active: false,
    });
    themeOrderIds.push(theme.id);
  }
  for (const sortOrder of ['asc', 'desc'] as const) {
    const result = await themes.findByCommunityId(themeOrderCommunity.id, {
      page: 1,
      limit: 20,
      sortBy: 'name',
      sortOrder,
    });
    const expectedIds = [
      themeOrderIds[1],
      themeOrderIds[5],
      themeOrderIds[6],
      themeOrderIds[4],
      themeOrderIds[3],
      themeOrderIds[0],
      themeOrderIds[2],
    ];
    assert.deepEqual(
      result.data.map((row) => row.id),
      sortOrder === 'asc' ? expectedIds : expectedIds.reverse()
    );
  }
  assert.equal(await stories.delete(thirdStory.id), true);
  assert.equal(await stories.findById(thirdStory.id), null);
  assert.equal(await themes.delete(nullTheme.id), true);
  assert.equal(await themes.findById(nullTheme.id), null);
}
