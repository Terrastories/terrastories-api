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
}
