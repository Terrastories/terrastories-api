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
  const { StoryRepository } = await import(
    '../src/repositories/story.repository.js'
  );
  const { ThemesRepository } = await import(
    '../src/repositories/themes.repository.js'
  );

  const communities = new CommunityRepository(database as any);
  const places = new PlaceRepository(database as any);
  const users = new UserRepository(database as any);
  const speakers = new SpeakerRepository(database as any);
  const files = new FileRepository(database as any);
  const stories = new StoryRepository(database as any);
  const themes = new ThemesRepository(database as any);

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

  // --- StoryRepository -------------------------------------------------

  const storyCommunity = await communities.create({
    name: 'Story Contract Community',
  });
  const storyAuthor = await users.create({
    email: 'story.contract@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Story',
    lastName: 'Author',
    communityId: storyCommunity.id,
  });
  const storyPlaceAlpha = await places.create({
    name: 'Story Place Alpha',
    communityId: storyCommunity.id,
    latitude: -1.4,
    longitude: -48.4,
  });
  const storyPlaceBeta = await places.create({
    name: 'Story Place Beta',
    communityId: storyCommunity.id,
    latitude: -1.5,
    longitude: -48.5,
  });
  const storySpeaker = await speakers.create({
    name: 'Story Speaker Mana',
    communityId: storyCommunity.id,
  });

  // placeIds deliberately reverse the creation order so the read-back proves
  // associations follow the given array order (sortOrder), not place id order.
  const riverStory = await stories.create({
    title: 'River Song Story',
    description: 'A story about the great river',
    slug: 'river-song-story',
    communityId: storyCommunity.id,
    createdBy: storyAuthor.id,
    mediaUrls: [
      'https://example.test/river-song.mp3',
      'https://example.test/river-song.jpg',
    ],
    language: 'pt',
    tags: ['Water'],
    placeIds: [storyPlaceBeta.id, storyPlaceAlpha.id],
    speakerIds: [storySpeaker.id],
  });
  const mountainStory = await stories.create({
    title: 'Mountain Tale',
    description: 'A tale of high peaks',
    slug: 'mountain-tale',
    communityId: storyCommunity.id,
    createdBy: storyAuthor.id,
    tags: ['Land'],
  });
  const forestStory = await stories.create({
    title: 'Forest Chant',
    description: 'A chant under the trees',
    slug: 'forest-chant',
    communityId: storyCommunity.id,
    createdBy: storyAuthor.id,
    tags: ['Water', 'Sacred'],
  });

  const readStory = await stories.findByIdWithRelations(riverStory.id);
  if (!readStory) {
    throw new Error(
      'stories.findByIdWithRelations must return the river story'
    );
  }
  assert.equal(readStory.title, 'River Song Story');
  assert.equal(readStory.description, 'A story about the great river');
  assert.equal(readStory.slug, 'river-song-story');
  assert.equal(readStory.communityId, storyCommunity.id);
  assert.equal(readStory.createdBy, storyAuthor.id);
  assert.deepEqual(readStory.mediaUrls, [
    'https://example.test/river-song.mp3',
    'https://example.test/river-song.jpg',
  ]);
  assert.equal(readStory.language, 'pt');
  assert.deepEqual(readStory.tags, ['Water']);
  assert.deepEqual(
    readStory.places.map((place) => place.id),
    [storyPlaceBeta.id, storyPlaceAlpha.id]
  );
  assert.deepEqual(
    readStory.speakers.map((speaker) => speaker.id),
    [storySpeaker.id]
  );
  assertValidDate(readStory.createdAt, 'stories.create createdAt');

  // Case-insensitive title search must behave identically on both backends.
  for (const search of ['river', 'RIVER']) {
    const found = await stories.findMany(
      { communityId: storyCommunity.id, search },
      { page: 1, limit: 10 }
    );
    assert.equal(found.total, 1);
    assert.deepEqual(
      found.data.map((story) => story.id),
      [riverStory.id],
      `stories.findMany({ search: '${search}' }) must find only the river story`
    );
  }

  // Tag filter matches stories whose tags array contains the exact element.
  const waterTagged = await stories.findMany(
    { communityId: storyCommunity.id, tags: ['Water'] },
    { page: 1, limit: 10 }
  );
  assert.equal(waterTagged.total, 2);
  assert.deepEqual(
    new Set(waterTagged.data.map((story) => story.id)),
    new Set([riverStory.id, forestStory.id])
  );

  // The create API does not accept timestamps, but ordering is still
  // deterministic: createdAt never decreases across the three inserts and
  // findMany sorts by createdAt desc with an id-desc tiebreak, so the pages
  // are exactly newest-first no matter whether timestamps collide.
  const storyPageOne = await stories.findMany(
    { communityId: storyCommunity.id },
    { page: 1, limit: 2 }
  );
  const storyPageTwo = await stories.findMany(
    { communityId: storyCommunity.id },
    { page: 2, limit: 2 }
  );
  assert.equal(storyPageOne.total, 3);
  assert.equal(storyPageOne.totalPages, 2);
  assert.deepEqual(
    storyPageOne.data.map((story) => story.id),
    [forestStory.id, mountainStory.id]
  );
  assert.deepEqual(
    storyPageTwo.data.map((story) => story.id),
    [riverStory.id]
  );

  const updatedStory = await stories.update(riverStory.id, {
    title: 'River Song Story Amended',
    tags: ['Water', 'Flood'],
  });
  if (!updatedStory) {
    throw new Error('stories.update must return the amended story');
  }
  assert.equal(updatedStory.title, 'River Song Story Amended');
  assert.deepEqual(updatedStory.tags, ['Water', 'Flood']);
  assertValidDate(updatedStory.updatedAt, 'stories.update updatedAt');
  assert.ok(
    updatedStory.updatedAt.getTime() >= updatedStory.createdAt.getTime(),
    'stories.update updatedAt must not be older than createdAt'
  );
  const rereadStory = await stories.findById(riverStory.id);
  if (!rereadStory) {
    throw new Error('stories.findById must return the amended story');
  }
  assert.equal(rereadStory.title, 'River Song Story Amended');
  assert.deepEqual(rereadStory.tags, ['Water', 'Flood']);

  assert.equal(await stories.delete(mountainStory.id), true);
  assert.equal(await stories.findById(mountainStory.id), null);

  // Story-derived projections must not widen a restricted place's audience
  // (SPEC-V2 §6.4), and a withdrawn interviewer must carry isActive = false
  // so callers can withhold it.
  const restrictedInterviewPlace = await places.create({
    name: 'Restricted Interview Place',
    communityId: storyCommunity.id,
    latitude: -1.6,
    longitude: -48.6,
    isRestricted: true,
  });
  const withdrawnInterviewer = await speakers.create({
    name: 'Withdrawn Interviewer',
    communityId: storyCommunity.id,
    isActive: false,
  });
  const restrictedInterviewStory = await stories.create({
    title: 'Restricted Interview Story',
    slug: 'restricted-interview-story',
    communityId: storyCommunity.id,
    createdBy: storyAuthor.id,
    interviewLocationId: restrictedInterviewPlace.id,
    interviewerId: withdrawnInterviewer.id,
  });
  const restrictedInterviewRead = await stories.findByIdWithRelations(
    restrictedInterviewStory.id
  );
  assert.ok(restrictedInterviewRead, 'restricted-interview story must load');
  assert.equal(
    restrictedInterviewRead.interviewLocation ?? null,
    null,
    'a restricted interview location must not be hydrated into a story'
  );
  assert.equal(
    restrictedInterviewRead.interviewer?.id,
    withdrawnInterviewer.id
  );
  assert.equal(
    restrictedInterviewRead.interviewer?.isActive,
    false,
    'a withdrawn interviewer must carry isActive = false'
  );

  const openInterviewStory = await stories.create({
    title: 'Open Interview Story',
    slug: 'open-interview-story',
    communityId: storyCommunity.id,
    createdBy: storyAuthor.id,
    interviewLocationId: storyPlaceAlpha.id,
    interviewerId: storySpeaker.id,
  });
  const openInterviewRead = await stories.findByIdWithRelations(
    openInterviewStory.id
  );
  assert.equal(openInterviewRead?.interviewLocation?.id, storyPlaceAlpha.id);
  assert.equal(openInterviewRead?.interviewLocation?.latitude, -1.4);
  assert.equal(openInterviewRead?.interviewer?.id, storySpeaker.id);
  assert.equal(openInterviewRead?.interviewer?.isActive, true);

  // --- ThemesRepository ------------------------------------------------

  const themeCommunity = await communities.create({
    name: 'Theme Contract Community',
  });
  const riverTheme = await themes.create({
    name: 'River Theme',
    description: 'Map theme for the river basin',
    active: true,
    centerLat: 45.123456,
    centerLong: -123.456789,
    swBoundaryLat: 44.111111,
    swBoundaryLong: -124.222222,
    neBoundaryLat: 46.333333,
    neBoundaryLong: -122.444444,
    communityId: themeCommunity.id,
  });
  const sleepyRiverTheme = await themes.create({
    name: 'Sleepy River Theme',
    active: false,
    communityId: themeCommunity.id,
  });
  const mountainTheme = await themes.create({
    name: 'Mountain Theme',
    description: 'High peaks basemap',
    active: true,
    communityId: themeCommunity.id,
  });

  const readTheme = await themes.findById(riverTheme.id);
  if (!readTheme) {
    throw new Error('themes.findById must return the river theme');
  }
  assert.equal(readTheme.name, 'River Theme');
  assert.equal(readTheme.description, 'Map theme for the river basin');
  assert.equal(readTheme.active, true);
  const expectedCoordinates: Array<[string, number]> = [
    ['centerLat', 45.123456],
    ['centerLong', -123.456789],
    ['swBoundaryLat', 44.111111],
    ['swBoundaryLong', -124.222222],
    ['neBoundaryLat', 46.333333],
    ['neBoundaryLong', -122.444444],
  ];
  for (const [field, written] of expectedCoordinates) {
    const coordinate = (readTheme as any)[field];
    assert.equal(
      typeof coordinate,
      'number',
      `themes.create ${field} must read back as a number, got ${typeof coordinate}`
    );
    assert.equal(
      coordinate,
      written,
      `themes.create ${field} must round-trip exactly`
    );
  }

  // Case-insensitive search must behave identically on both backends. The
  // community also holds the inactive 'Sleepy River Theme' used by the count
  // case below, so 'river' correctly matches two names; both spellings must
  // at least find the active 'River Theme'.
  for (const query of ['river', 'RIVER']) {
    const byName = await themes.searchByName(themeCommunity.id, query);
    assert.deepEqual(
      new Set(byName.map((theme) => theme.id)),
      new Set([riverTheme.id, sleepyRiverTheme.id]),
      `themes.searchByName('${query}') must find both river-named themes`
    );
    const paged = await themes.searchThemes(themeCommunity.id, {
      query,
      page: 1,
      limit: 10,
    });
    assert.equal(paged.total, 2);
    assert.deepEqual(
      new Set(paged.data.map((theme) => theme.id)),
      new Set([riverTheme.id, sleepyRiverTheme.id]),
      `themes.searchThemes('${query}') must find both river-named themes`
    );
  }

  assert.equal(await themes.countByCommunityId(themeCommunity.id), 3);
  assert.equal(
    await themes.countByCommunityId(themeCommunity.id, {
      activeOnly: true,
      searchTerm: 'river',
    }),
    1
  );

  const renamedTheme = await themes.update(riverTheme.id, {
    name: 'River Theme Renamed',
  });
  if (!renamedTheme) {
    throw new Error('themes.update must return the renamed theme');
  }
  assert.equal(renamedTheme.name, 'River Theme Renamed');
  const rereadTheme = await themes.findById(riverTheme.id);
  assert.equal(rereadTheme?.name, 'River Theme Renamed');
  assertValidDate(renamedTheme.updatedAt, 'themes.update updatedAt');

  // Name ordering must be collation-independent byte order on both backends.
  const themeOrderCommunity = await communities.create({
    name: 'Theme Byte Order Community',
  });
  for (const name of ['Banana', 'Zebra', 'apple']) {
    await themes.create({ name, communityId: themeOrderCommunity.id });
  }
  const themesAsc = await themes.findByCommunityId(themeOrderCommunity.id, {
    page: 1,
    limit: 10,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.equal(themesAsc.total, 3);
  assert.deepEqual(
    themesAsc.data.map((theme) => theme.name),
    ['Banana', 'Zebra', 'apple']
  );
  const themesDesc = await themes.findByCommunityId(themeOrderCommunity.id, {
    page: 1,
    limit: 10,
    sortBy: 'name',
    sortOrder: 'desc',
  });
  assert.deepEqual(
    themesDesc.data.map((theme) => theme.name),
    ['apple', 'Zebra', 'Banana']
  );

  // Theme coordinates must be numbers on every return path, and zero must
  // survive (not become null or a string). PostgreSQL numeric decodes through
  // Drizzle mode 'number'; SQLite stores real.
  const coordinateCommunity = await communities.create({
    name: 'Theme Coordinate Community',
  });
  const zeroCoordinates = {
    centerLat: 0,
    centerLong: 0,
    swBoundaryLat: -1,
    swBoundaryLong: 0,
    neBoundaryLat: 0,
    neBoundaryLong: 1,
  };
  const assertThemeCoordinates = (
    theme: Record<string, unknown> | null | undefined,
    expected: Record<string, number>,
    label: string
  ): void => {
    assert.ok(theme, `${label} must return a theme`);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(typeof theme[key], 'number', `${label} ${key} type`);
      assert.equal(theme[key], value, `${label} ${key} value`);
    }
  };
  const zeroTheme = await themes.create({
    name: 'Zero Meridian Theme',
    description: 'equator and prime meridian',
    active: true,
    communityId: coordinateCommunity.id,
    ...zeroCoordinates,
  });
  const cid = coordinateCommunity.id;
  assertThemeCoordinates(zeroTheme, zeroCoordinates, 'create');
  assertThemeCoordinates(
    await themes.findById(zeroTheme.id),
    zeroCoordinates,
    'findById'
  );
  assertThemeCoordinates(
    await themes.findByIdAndCommunity(zeroTheme.id, cid),
    zeroCoordinates,
    'findByIdAndCommunity'
  );
  assertThemeCoordinates(
    (await themes.findByCommunityId(cid))[0],
    zeroCoordinates,
    'findByCommunityId'
  );
  assertThemeCoordinates(
    (await themes.findByCommunityId(cid, { page: 1, limit: 10 })).data[0],
    zeroCoordinates,
    'findByCommunityId paginated'
  );
  assertThemeCoordinates(
    (await themes.findByCommunityIdPaginated(cid, { page: 1, limit: 10 }))
      .themes[0],
    zeroCoordinates,
    'findByCommunityIdPaginated'
  );
  assertThemeCoordinates(
    (await themes.findActiveThemes(cid))[0],
    zeroCoordinates,
    'findActiveThemes'
  );
  assertThemeCoordinates(
    (await themes.searchByName(cid, 'meridian'))[0],
    zeroCoordinates,
    'searchByName'
  );
  assertThemeCoordinates(
    (await themes.searchByDescription(cid, 'equator'))[0],
    zeroCoordinates,
    'searchByDescription'
  );
  assertThemeCoordinates(
    (await themes.searchThemes(cid, { query: 'meridian', page: 1, limit: 10 }))
      .data[0],
    zeroCoordinates,
    'searchThemes'
  );
  assertThemeCoordinates(
    (await themes.searchActiveThemes(cid, 'meridian'))[0],
    zeroCoordinates,
    'searchActiveThemes'
  );
  const shifted = { ...zeroCoordinates, centerLat: 0.5, centerLong: -0.25 };
  assertThemeCoordinates(
    await themes.update(zeroTheme.id, { centerLat: 0.5, centerLong: -0.25 }),
    shifted,
    'update'
  );
  assertThemeCoordinates(
    await themes.updateByCommunity(zeroTheme.id, cid, {
      centerLat: 0,
      centerLong: 0,
    }),
    zeroCoordinates,
    'updateByCommunity'
  );
  assertThemeCoordinates(
    // Bounds are validated as a set, so update all four together.
    await themes.updateWithCommunityCheck(zeroTheme.id, cid, {
      swBoundaryLat: zeroCoordinates.swBoundaryLat,
      swBoundaryLong: zeroCoordinates.swBoundaryLong,
      neBoundaryLat: zeroCoordinates.neBoundaryLat,
      neBoundaryLong: zeroCoordinates.neBoundaryLong,
    }),
    zeroCoordinates,
    'updateWithCommunityCheck'
  );

  assert.equal(await themes.delete(mountainTheme.id), true);
  assert.equal(await themes.findById(mountainTheme.id), null);

  // --- Dual-backend additions: tenancy, normalized tags, deterministic
  // ordering, coordinate rounding and association ties. Each case uses fresh
  // communities and slugs so the totals asserted above never change.

  const { eq, sql } = await import('drizzle-orm');
  const { dialectOf, tablesFor } = await import('../src/db/dialect.js');
  const dialectTables = tablesFor(database as any);

  // 1. Speaker tenancy: validation is scoped to one community, tolerates
  // duplicate ids, and rejects unknown ids (SPEC-V2 Section 6.3).
  const tenancyCommunity = await communities.create({
    name: 'Speaker Tenancy Community',
  });
  const tenancyOtherCommunity = await communities.create({
    name: 'Speaker Tenancy Other Community',
  });
  const tenancySpeaker = await speakers.create({
    name: 'Tenancy Speaker Mana',
    communityId: tenancyCommunity.id,
  });
  const tenancyForeignSpeaker = await speakers.create({
    name: 'Tenancy Foreign Speaker',
    communityId: tenancyOtherCommunity.id,
  });
  assert.equal(
    await stories.validateSpeakersInCommunity(
      [tenancyForeignSpeaker.id],
      tenancyCommunity.id
    ),
    false,
    'a speaker from another community must not validate'
  );
  assert.equal(
    await stories.validateSpeakersInCommunity(
      [tenancySpeaker.id],
      tenancyCommunity.id
    ),
    true
  );
  assert.equal(
    await stories.validateSpeakersInCommunity(
      [tenancySpeaker.id, tenancySpeaker.id],
      tenancyCommunity.id
    ),
    true,
    'duplicate speaker ids must still validate'
  );
  assert.equal(
    await stories.validateSpeakersInCommunity([999999], tenancyCommunity.id),
    false,
    'a nonexistent speaker id must not validate'
  );

  // 2. Normalized tag matching (SPEC-V2 Section 6.3): NFC + lower-case on the
  // application side, so case and combining-mark variants match identically
  // on both backends. 'Café' is composed (NFC), 'Café' decomposed.
  const tagCommunity = await communities.create({
    name: 'Normalized Tag Community',
  });
  const tagAuthor = await users.create({
    email: 'normalized-tags@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Normalized',
    lastName: 'Tags',
    communityId: tagCommunity.id,
  });
  const tagWater = await stories.create({
    title: 'Tag Water Exact',
    slug: 'tag-water-exact',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
    tags: ['Water'],
  });
  const tagLower = await stories.create({
    title: 'Tag Water Lower',
    slug: 'tag-water-lower',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
    tags: ['water'],
  });
  const tagMixed = await stories.create({
    title: 'Tag Water Upper Land',
    slug: 'tag-water-upper-land',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
    tags: ['WATER', 'Land'],
  });
  const tagComposed = await stories.create({
    title: 'Tag Cafe Composed',
    slug: 'tag-cafe-composed',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
    // Composed (NFC) accent: e-acute as a single code point.
    tags: ['Café'],
  });
  const tagDecomposed = await stories.create({
    title: 'Tag Cafe Decomposed',
    slug: 'tag-cafe-decomposed',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
    // Decomposed (NFD) accent: 'e' plus combining acute.
    tags: ['Café'],
  });
  await stories.create({
    title: 'Tag Untagged Story',
    slug: 'tag-untagged-story',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
  });

  const tagWaterStories = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['water'] },
    { page: 1, limit: 10 }
  );
  assert.equal(
    tagWaterStories.total,
    3,
    "tags ['water'] must match case variants"
  );
  assert.deepEqual(
    new Set(tagWaterStories.data.map((story) => story.id)),
    new Set([tagWater.id, tagLower.id, tagMixed.id])
  );

  const tagCafeStories = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['CAFÉ'] },
    { page: 1, limit: 10 }
  );
  assert.equal(
    tagCafeStories.total,
    2,
    "tags ['CAFÉ'] (composed) must match both café stories"
  );
  assert.deepEqual(
    new Set(tagCafeStories.data.map((story) => story.id)),
    new Set([tagComposed.id, tagDecomposed.id])
  );

  const tagAnyStories = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['Land', 'café'] },
    { page: 1, limit: 10 }
  );
  assert.equal(tagAnyStories.total, 3, 'tag filter is match-any');
  assert.deepEqual(
    new Set(tagAnyStories.data.map((story) => story.id)),
    new Set([tagMixed.id, tagComposed.id, tagDecomposed.id])
  );

  // Paged tag queries page the full match set in newest-first order
  // (createdAt desc, id desc) without duplicating or skipping rows.
  for (let index = 1; index < tagWaterStories.data.length; index += 1) {
    const previous = tagWaterStories.data[index - 1];
    const current = tagWaterStories.data[index];
    assert.ok(
      previous.createdAt.getTime() > current.createdAt.getTime() ||
        (previous.createdAt.getTime() === current.createdAt.getTime() &&
          previous.id > current.id),
      'tag query order must be createdAt desc, then id desc'
    );
  }
  const tagPageOne = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['water'] },
    { page: 1, limit: 2 }
  );
  const tagPageTwo = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['water'] },
    { page: 2, limit: 2 }
  );
  assert.equal(tagPageOne.total, 3);
  assert.equal(tagPageOne.totalPages, 2);
  assert.equal(tagPageTwo.total, 3);
  assert.equal(tagPageTwo.totalPages, 2);
  assert.equal(tagPageOne.data.length, 2);
  assert.equal(tagPageTwo.data.length, 1);
  assert.deepEqual(
    [...tagPageOne.data, ...tagPageTwo.data].map((story) => story.id),
    tagWaterStories.data.map((story) => story.id),
    'paged tag rows must be the full set in the same newest-first order'
  );
  assert.equal(
    new Set([...tagPageOne.data, ...tagPageTwo.data].map((story) => story.id))
      .size,
    3,
    'paged tag rows must not duplicate'
  );

  // An imported row whose tags column holds valid JSON that is not an array
  // must match no tag on either backend, without throwing.
  const malformedTagsStory = await stories.create({
    title: 'Malformed Tags Story',
    slug: 'malformed-tags-story',
    communityId: tagCommunity.id,
    createdBy: tagAuthor.id,
    tags: ['water'],
  });
  if (dialectOf(database) === 'postgresql') {
    await (database as any).execute(
      sql`UPDATE stories SET tags = '5'::jsonb WHERE id = ${malformedTagsStory.id}`
    );
  } else {
    await (database as any).run(
      sql`UPDATE stories SET tags = '5' WHERE id = ${malformedTagsStory.id}`
    );
  }
  const malformedTagQuery = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['water'] },
    { page: 1, limit: 10 }
  );
  assert.equal(
    malformedTagQuery.total,
    3,
    'a non-array tags value must contribute no matches'
  );
  assert.equal(
    malformedTagQuery.data.some((story) => story.id === malformedTagsStory.id),
    false,
    'the malformed-tags story must match no tag query'
  );
  const malformedSoloQuery = await stories.findMany(
    { communityId: tagCommunity.id, tags: ['5'] },
    { page: 1, limit: 10 }
  );
  assert.equal(
    malformedSoloQuery.total,
    0,
    'a numeric tags value must not match a string tag'
  );

  // 3. findMany list rows (not findById) must carry associations in the
  // created placeIds order, and the speaker association.
  const listRowCommunity = await communities.create({
    name: 'List Row Relations Community',
  });
  const listRowAuthor = await users.create({
    email: 'list-row-relations@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'List',
    lastName: 'Row',
    communityId: listRowCommunity.id,
  });
  const listRowPlaceOne = await places.create({
    name: 'List Row Place One',
    communityId: listRowCommunity.id,
    latitude: -1.1,
    longitude: -48.1,
  });
  const listRowPlaceTwo = await places.create({
    name: 'List Row Place Two',
    communityId: listRowCommunity.id,
    latitude: -1.2,
    longitude: -48.2,
  });
  const listRowSpeaker = await speakers.create({
    name: 'List Row Speaker',
    communityId: listRowCommunity.id,
  });
  await stories.create({
    title: 'List Row Story',
    slug: 'list-row-story',
    communityId: listRowCommunity.id,
    createdBy: listRowAuthor.id,
    // Deliberately reversed place order so the read-back proves sortOrder.
    placeIds: [listRowPlaceTwo.id, listRowPlaceOne.id],
    speakerIds: [listRowSpeaker.id],
  });
  const listRowFound = await stories.findMany(
    { communityId: listRowCommunity.id },
    { page: 1, limit: 10 }
  );
  assert.equal(listRowFound.total, 1);
  const listRow = listRowFound.data[0];
  assert.deepEqual(
    listRow.places.map((place) => place.id),
    [listRowPlaceTwo.id, listRowPlaceOne.id],
    'findMany rows must keep the created place order'
  );
  assert.deepEqual(
    listRow.speakers.map((speaker) => speaker.id),
    [listRowSpeaker.id],
    'findMany rows must carry the speaker association'
  );

  // 4. Search matches the title or description branch alone.
  const searchBranchCommunity = await communities.create({
    name: 'Search Branch Community',
  });
  const searchBranchAuthor = await users.create({
    email: 'search-branch@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Search',
    lastName: 'Branch',
    communityId: searchBranchCommunity.id,
  });
  const titleOnlyStory = await stories.create({
    title: 'Heron Morning',
    description: 'An ordinary morning by the water',
    slug: 'heron-morning',
    communityId: searchBranchCommunity.id,
    createdBy: searchBranchAuthor.id,
  });
  const descriptionOnlyStory = await stories.create({
    title: 'Raptor Watch',
    description: 'A kestrel hovers over the field',
    slug: 'raptor-watch',
    communityId: searchBranchCommunity.id,
    createdBy: searchBranchAuthor.id,
  });
  const heronFound = await stories.findMany(
    { communityId: searchBranchCommunity.id, search: 'heron' },
    { page: 1, limit: 10 }
  );
  assert.equal(heronFound.total, 1);
  assert.deepEqual(
    heronFound.data.map((story) => story.id),
    [titleOnlyStory.id],
    "search 'heron' must match only the title branch"
  );
  const kestrelFound = await stories.findMany(
    { communityId: searchBranchCommunity.id, search: 'KESTREL' },
    { page: 1, limit: 10 }
  );
  assert.equal(kestrelFound.total, 1);
  assert.deepEqual(
    kestrelFound.data.map((story) => story.id),
    [descriptionOnlyStory.id],
    "search 'KESTREL' must match only the description branch"
  );

  // 5. Equal createdAt values must fall back to descending id so pages
  // neither duplicate nor skip rows.
  const equalTimeCommunity = await communities.create({
    name: 'Equal Timestamp Community',
  });
  const equalTimeAuthor = await users.create({
    email: 'equal-timestamps@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Equal',
    lastName: 'Timestamp',
    communityId: equalTimeCommunity.id,
  });
  const equalTimeStories: Array<{ id: number }> = [];
  for (const [title, slug] of [
    ['Equal Timestamp One', 'equal-timestamp-one'],
    ['Equal Timestamp Two', 'equal-timestamp-two'],
    ['Equal Timestamp Three', 'equal-timestamp-three'],
  ]) {
    equalTimeStories.push(
      await stories.create({
        title,
        slug,
        communityId: equalTimeCommunity.id,
        createdBy: equalTimeAuthor.id,
      })
    );
  }
  const equalInstant = new Date('2026-03-15T12:00:00Z');
  await (database as any)
    .update(dialectTables.stories)
    .set({ createdAt: equalInstant })
    .where(eq(dialectTables.stories.communityId, equalTimeCommunity.id));
  const equalTimePage = await stories.findMany(
    { communityId: equalTimeCommunity.id },
    { page: 1, limit: 10 }
  );
  assert.equal(equalTimePage.total, 3);
  for (const story of equalTimePage.data) {
    assert.equal(
      story.createdAt.getTime(),
      equalInstant.getTime(),
      'forced createdAt must round-trip identically'
    );
  }
  const expectedDescendingIds = equalTimeStories
    .map((story) => story.id)
    .sort((left, right) => right - left);
  assert.deepEqual(
    equalTimePage.data.map((story) => story.id),
    expectedDescendingIds,
    'equal createdAt must order by descending id'
  );
  const equalPageOne = await stories.findMany(
    { communityId: equalTimeCommunity.id },
    { page: 1, limit: 2 }
  );
  const equalPageTwo = await stories.findMany(
    { communityId: equalTimeCommunity.id },
    { page: 2, limit: 2 }
  );
  assert.deepEqual(
    [...equalPageOne.data, ...equalPageTwo.data].map((story) => story.id),
    expectedDescendingIds,
    'paged equal-timestamp rows must not duplicate or skip'
  );

  // 6. Equal theme names tiebreak by id in both sort directions.
  const twinThemeCommunity = await communities.create({
    name: 'Twin Theme Community',
  });
  const twinThemes: Array<{ id: number }> = [
    await themes.create({
      name: 'Twin Theme',
      communityId: twinThemeCommunity.id,
    }),
    await themes.create({
      name: 'Twin Theme',
      communityId: twinThemeCommunity.id,
    }),
    await themes.create({
      name: 'Twin Theme',
      communityId: twinThemeCommunity.id,
    }),
  ];
  const twinThemeAsc = await themes.findByCommunityId(twinThemeCommunity.id, {
    page: 1,
    limit: 10,
    sortBy: 'name',
    sortOrder: 'asc',
  });
  assert.equal(twinThemeAsc.total, 3);
  assert.deepEqual(
    twinThemeAsc.data.map((theme) => theme.id),
    twinThemes.map((theme) => theme.id),
    'equal names must tiebreak by ascending id'
  );
  const twinThemeDesc = await themes.findByCommunityId(twinThemeCommunity.id, {
    page: 1,
    limit: 10,
    sortBy: 'name',
    sortOrder: 'desc',
  });
  assert.deepEqual(
    twinThemeDesc.data.map((theme) => theme.id),
    [...twinThemes].reverse().map((theme) => theme.id),
    'equal names must tiebreak by descending id in desc order'
  );

  // 7. countByCommunityId must keep the community predicate when combined
  // with active and search-term filters; a matching active theme in another
  // community must not leak into the count.
  const countedCommunity = await communities.create({
    name: 'Counted Themes Community',
  });
  const rivalCountedCommunity = await communities.create({
    name: 'Rival Counted Themes Community',
  });
  await themes.create({
    name: 'Estuary Active Theme',
    active: true,
    communityId: countedCommunity.id,
  });
  await themes.create({
    name: 'Estuary Dormant Theme',
    active: false,
    communityId: countedCommunity.id,
  });
  await themes.create({
    name: 'Estuary Rival Theme',
    active: true,
    communityId: rivalCountedCommunity.id,
  });
  assert.equal(await themes.countByCommunityId(countedCommunity.id), 2);
  assert.equal(
    await themes.countByCommunityId(countedCommunity.id, {
      activeOnly: true,
      searchTerm: 'estuary',
    }),
    1,
    "the rival community's active matching theme must not be counted"
  );
  assert.equal(
    await themes.countByCommunityId(rivalCountedCommunity.id, {
      activeOnly: true,
      searchTerm: 'estuary',
    }),
    1
  );

  // 8. Theme coordinates round to 6 decimals in the application so both
  // backends store and return the same value.
  const roundingCommunity = await communities.create({
    name: 'Rounding Coordinates Community',
  });
  const roundedTheme = await themes.create({
    name: 'Rounded Coordinates Theme',
    communityId: roundingCommunity.id,
    centerLat: 1.23456789,
  });
  assert.equal(
    (roundedTheme as any).centerLat,
    1.234568,
    'themes.create must round centerLat to 6 decimals'
  );
  const roundedRead = await themes.findById(roundedTheme.id);
  assert.ok(roundedRead, 'themes.findById must return the rounded theme');
  assert.equal(
    (roundedRead as any).centerLat,
    1.234568,
    'themes.findById must read the rounded centerLat back'
  );
  const roundedUpdate = await themes.update(roundedTheme.id, {
    centerLong: -2.0000004,
  });
  assert.ok(roundedUpdate, 'themes.update must return the rounded theme');
  assert.equal(
    (roundedUpdate as any).centerLong,
    -2,
    'themes.update must round centerLong -2.0000004 to -2'
  );
  const roundedReread = await themes.findById(roundedTheme.id);
  assert.ok(roundedReread, 'themes.findById must reread the rounded theme');
  assert.equal((roundedReread as any).centerLat, 1.234568);
  assert.equal((roundedReread as any).centerLong, -2);

  // 9. Association rows with equal sortOrder fall back to join-row id order,
  // which is not necessarily place id order.
  const tieOrderCommunity = await communities.create({
    name: 'Association Tie Order Community',
  });
  const tieOrderAuthor = await users.create({
    email: 'tie-order@example.test',
    passwordHash: 'repository-contract-hash',
    firstName: 'Tie',
    lastName: 'Order',
    communityId: tieOrderCommunity.id,
  });
  const tiePlaceLow = await places.create({
    name: 'Tie Place Low Id',
    communityId: tieOrderCommunity.id,
    latitude: -1.7,
    longitude: -48.7,
  });
  const tiePlaceHigh = await places.create({
    name: 'Tie Place High Id',
    communityId: tieOrderCommunity.id,
    latitude: -1.8,
    longitude: -48.8,
  });
  const tieStory = await stories.create({
    title: 'Tie Order Story',
    slug: 'tie-order-story',
    communityId: tieOrderCommunity.id,
    createdBy: tieOrderAuthor.id,
    // The higher place id is inserted first, so its join row has the lower
    // join-row id.
    placeIds: [tiePlaceHigh.id, tiePlaceLow.id],
  });
  await (database as any)
    .update(dialectTables.storyPlaces)
    .set({ sortOrder: 7 })
    .where(eq(dialectTables.storyPlaces.storyId, tieStory.id));
  const tieRead = await stories.findByIdWithRelations(tieStory.id);
  assert.ok(tieRead, 'the tie-order story must load with relations');
  assert.deepEqual(
    tieRead.places.map((place) => place.id),
    [tiePlaceHigh.id, tiePlaceLow.id],
    'equal sortOrder must fall back to join-row id order'
  );
}
