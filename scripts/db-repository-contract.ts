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
}
