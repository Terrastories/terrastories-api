/**
 * Chapter: Elena, an editor, authors places, speakers and stories, attaches
 * media and external links, and imports CSVs.
 */
import { PNG_BYTES, multipart, wavBytes } from '../client.js';
import {
  activate,
  attach,
  field,
  guarded,
  num,
  str,
  upload,
  val,
  type Ctx,
} from '../context.js';
import { dig } from '../walk.js';

export const PERSONA_EDITOR = 'Editor';

const png = (name: string) => ({ name, type: 'image/png', bytes: PNG_BYTES });
const wav = (name: string) => ({ name, type: 'audio/wav', bytes: wavBytes() });

export async function editorChapter(ctx: Ctx): Promise<void> {
  const { w, s } = ctx;
  const acct = s.accounts.elena!;
  w.chapter(
    PERSONA_EDITOR,
    'Elena writes the stories',
    `Elena is an editor created by Ana. All content carries the run id "${w.runId}" so the cleanup can find it.`
  );
  await guarded(ctx, 'editor', async () => {
    const elena = (s.actors.elena = w.actor('Elena', 'editor'));
    await activate(ctx, elena, acct, ['A06']);
    await w.step({
      who: elena,
      say: 'opens the dashboard; the menu shows Stories, Speakers, Places and Import',
      method: 'GET',
      path: '/v2/auth/me',
      expect: 200,
      covers: ['B01', 'B08', 'M12'],
      show: (r) => [
        field('Hello', val(r, 'user', 'displayName')),
        field('role', val(r, 'user', 'role')),
      ],
    });

    // ---- places --------------------------------------------------------
    const place = await w.step({
      who: elena,
      say: `fills the new place form: "${w.runId} Riverbend" with coordinates, region and type`,
      method: 'POST',
      path: '/v2/places',
      json: {
        name: `${w.runId} Riverbend`,
        description: '<p>Where the river bends.</p>',
        typeOfPlace: 'landing',
        region: 'North',
        latitude: 6.8,
        longitude: -58.15,
      },
      expect: 201,
      covers: ['C10'],
      show: (r) => [
        field('name', val(r, 'data', 'name')),
        field('region', val(r, 'data', 'region')),
        field('type badge', val(r, 'data', 'typeOfPlace')),
      ],
    });
    const placeId = num(place, 'data', 'id');
    s.places.push(placeId);
    s.ids.place = placeId;

    const audio = await upload(
      ctx,
      elena,
      'picks the place-name audio file (the browser uploads it to private staging)',
      wav(`${w.runId}-name.wav`),
      ['C10']
    );
    s.files.placeAudio = audio;
    s.attachments.placeAudio = await attach(
      ctx,
      elena,
      'attaches the audio to the place as its spoken name',
      {
        fileId: audio,
        ownerType: 'place',
        ownerId: placeId,
        role: 'place_name_audio',
        ordinal: 0,
      },
      ['C10']
    );
    const photo = await upload(
      ctx,
      elena,
      'picks a photo for the place',
      png(`${w.runId}-place.png`),
      ['C10']
    );
    s.files.placePhoto = photo;
    s.attachments.placePhoto = await attach(
      ctx,
      elena,
      'attaches the photo to the place',
      {
        fileId: photo,
        ownerType: 'place',
        ownerId: placeId,
        role: 'place_photo',
        ordinal: 0,
      },
      ['C10']
    );

    const bare = await w.step({
      who: elena,
      say: 'creates a second place with no coordinates yet (the latitude and longitude pair is optional)',
      method: 'POST',
      path: '/v2/places',
      json: {
        name: `${w.runId} Unmapped spot`,
        latitude: null,
        longitude: null,
      },
      expect: 201,
      covers: ['C10'],
      show: (r) => [
        field('latitude', val(r, 'data', 'latitude')),
        field('longitude', val(r, 'data', 'longitude')),
        'the place is listed but has no map marker',
      ],
    });
    const bareId = num(bare, 'data', 'id');
    s.places.push(bareId);
    await w.step({
      who: elena,
      say: 'sends a half-filled coordinate pair',
      method: 'POST',
      path: '/v2/places',
      json: { name: `${w.runId} Half pair`, latitude: 5 },
      expect: 400,
      negative: true,
      covers: ['C10'],
      show: 'the form marks longitude as required when latitude is set',
    });
    await w.step({
      who: elena,
      say: 'drags the marker of the unmapped place onto the map and edits its details',
      method: 'PATCH',
      path: `/v2/places/${bareId}`,
      json: {
        latitude: 6.9,
        longitude: -58.2,
        region: 'North',
        description: '<p>Now on the map.</p>',
      },
      expect: 200,
      covers: ['C11'],
      show: (r) => [
        field('latitude', val(r, 'data', 'latitude')),
        field('longitude', val(r, 'data', 'longitude')),
      ],
    });

    // ---- speakers ------------------------------------------------------
    const speaker = await w.step({
      who: elena,
      say: `creates the speaker "${w.runId} Maria" with a birthplace from the same community`,
      method: 'POST',
      path: '/v2/speakers',
      json: {
        name: `${w.runId} Maria`,
        birthDate: '1948-03-09',
        birthplaceId: placeId,
        affiliation: 'River village',
      },
      expect: 201,
      covers: ['C20'],
      show: (r) => [
        field('name', val(r, 'data', 'name')),
        field('community', val(r, 'data', 'affiliation')),
        field('birthdate', val(r, 'data', 'birthDate')),
        field('birthplace', dig(r, 'data', 'birthplace', 'name')),
      ],
    });
    const speakerId = num(speaker, 'data', 'id');
    s.speakers.push(speakerId);
    s.ids.speaker = speakerId;
    const speakerPhoto = await upload(
      ctx,
      elena,
      'picks a portrait for the speaker',
      png(`${w.runId}-maria.png`),
      ['C20']
    );
    s.files.speakerPhoto = speakerPhoto;
    s.attachments.speakerPhoto = await attach(
      ctx,
      elena,
      'attaches the portrait to the speaker',
      {
        fileId: speakerPhoto,
        ownerType: 'speaker',
        ownerId: speakerId,
        role: 'speaker_photo',
        ordinal: 0,
      },
      ['C20']
    );
    await w.step({
      who: elena,
      say: 'edits the speaker (community name and birthplace)',
      method: 'PATCH',
      path: `/v2/speakers/${speakerId}`,
      json: { affiliation: 'Upriver village', birthplaceId: bareId },
      expect: 200,
      covers: ['C20'],
      show: (r) => [
        field('community', val(r, 'data', 'affiliation')),
        field('birthplace', dig(r, 'data', 'birthplace', 'name')),
      ],
    });
    await w.step({
      who: elena,
      say: 'picks a birthplace id that does not exist in this community',
      method: 'PATCH',
      path: `/v2/speakers/${speakerId}`,
      json: { birthplaceId: 2147483000 },
      expect: [400, 404, 422],
      negative: true,
      covers: ['C20'],
      show: 'the birthplace select rejects an unknown place',
    });

    // ---- stories -------------------------------------------------------
    const story = await w.step({
      who: elena,
      say: `writes a story "${w.runId} How the river got its name" for editors only, with the place and the speaker`,
      method: 'POST',
      path: '/v2/stories',
      json: {
        title: `${w.runId} How the river got its name`,
        description: '<p>An elder tells it.</p>',
        visibility: 'editors',
        topic: 'water',
        language: 'en',
        dateInterviewed: '2024-05-01T00:00:00.000Z',
        placeIds: [placeId],
        speakerIds: [speakerId],
        interviewLocationId: placeId,
        interviewerId: speakerId,
      },
      expect: 201,
      covers: ['C02'],
      show: (r) => [
        field('title', val(r, 'data', 'title')),
        field(
          'audience badge',
          val(r, 'data', 'visibility') + ' (UI label: Editor)'
        ),
        field('places', ((val(r, 'data', 'places') as unknown[]) ?? []).length),
        field(
          'speakers',
          ((val(r, 'data', 'speakers') as unknown[]) ?? []).length
        ),
        'map point: one marker with the place name',
      ],
    });
    const storyId = num(story, 'data', 'id');
    s.stories.push(storyId);
    s.ids.story = storyId;
    const m1 = await upload(
      ctx,
      elena,
      'adds a photo to the story',
      png(`${w.runId}-s1.png`),
      ['C02']
    );
    const m2 = await upload(
      ctx,
      elena,
      'adds a second image to the story',
      png(`${w.runId}-s2.png`),
      ['C02']
    );
    const a1 = await attach(
      ctx,
      elena,
      'attaches the first image to the story gallery',
      {
        fileId: m1,
        ownerType: 'story',
        ownerId: storyId,
        role: 'story_media',
        ordinal: 0,
      },
      ['C02']
    );
    const a2 = await attach(
      ctx,
      elena,
      'attaches the second image to the story gallery',
      {
        fileId: m2,
        ownerType: 'story',
        ownerId: storyId,
        role: 'story_media',
        ordinal: 1,
      },
      ['C02']
    );
    s.attachments.storyMedia1 = a1;
    s.attachments.storyMedia2 = a2;
    s.files.storyMedia2 = m2;
    s.files.storyMedia1 = m1;
    await w.step({
      who: elena,
      say: 'drags the second image above the first',
      method: 'PATCH',
      path: '/v2/attachments/reorder',
      json: {
        ownerType: 'story',
        ownerId: storyId,
        role: 'story_media',
        attachmentIds: [a2, a1],
      },
      expect: 200,
      covers: ['V17'],
      show: 'the gallery order is saved',
    });
    await w.step({
      who: elena,
      say: 'reads the metadata of the first image (name, type, size, checksum; never the storage key)',
      method: 'GET',
      path: `/v2/media/${m1}/metadata`,
      expect: 200,
      covers: ['V18'],
      check: (r) =>
        JSON.stringify(r.json).includes('storageKey')
          ? 'storage key leaked'
          : undefined,
      show: (r) => [
        field('name', val(r, 'data', 'originalName')),
        field('type', val(r, 'data', 'mimeType')),
        field('size', val(r, 'data', 'byteSize')),
      ],
    });
    await w.step({
      who: elena,
      say: 'removes the first image from the gallery (confirm dialog)',
      method: 'DELETE',
      path: `/v2/attachments/${a1}`,
      expect: 204,
      covers: ['C04'],
      show: 'the element disappears from the form',
    });
    await w.step({
      who: elena,
      say: 'the form also clears the now-unused file out of storage',
      method: 'DELETE',
      path: `/v2/media/${m1}`,
      expect: [204, 404],
      covers: ['C04', 'V18'],
    });
    w.skip(
      ['V18'],
      'Elena asks to copy a file for publication',
      'deferred: the copy-for-publication route has no handler yet (handoff V18), so only metadata and staging delete are walked',
      'Elena',
      true
    );
    const stray = await upload(
      ctx,
      elena,
      'picks a wrong file by mistake; it only sits in private staging',
      png(`${w.runId}-stray.png`),
      ['V18']
    );
    await w.step({
      who: elena,
      say: 'throws the unattached staging file away',
      method: 'DELETE',
      path: `/v2/media/${stray}`,
      expect: 204,
      covers: ['V18'],
      show: 'the bytes are scheduled for removal',
    });

    await w.step({
      who: elena,
      say: 'switches the story audience to Anonymous (public) and changes its topic',
      method: 'PATCH',
      path: `/v2/stories/${storyId}`,
      json: { visibility: 'public', topic: 'rivers' },
      expect: 200,
      covers: ['C03'],
      show: (r) => [
        field('audience', val(r, 'data', 'visibility')),
        field('topic', val(r, 'data', 'topic')),
      ],
    });
    await w.step({
      who: elena,
      say: 'replaces the story places with both places and the speakers with the one speaker',
      method: 'PUT',
      path: `/v2/stories/${storyId}/places`,
      json: { placeIds: [placeId, bareId] },
      expect: 200,
      covers: ['C03'],
      show: (r) => [
        field(
          'places on the story',
          ((val(r, 'data', 'places') as unknown[]) ?? []).length
        ),
      ],
    });
    await w.step({
      who: elena,
      say: 'sets the story speakers again',
      method: 'PUT',
      path: `/v2/stories/${storyId}/speakers`,
      json: { speakerIds: [speakerId] },
      expect: 200,
      covers: ['C03'],
      show: (r) => [
        field(
          'speakers on the story',
          ((val(r, 'data', 'speakers') as unknown[]) ?? []).length
        ),
      ],
    });

    const draft = await w.step({
      who: elena,
      say: 'starts a draft story for editors only (the default audience) that readers must never see',
      method: 'POST',
      path: '/v2/stories',
      json: {
        title: `${w.runId} Editors-only draft`,
        visibility: 'editors',
        placeIds: [placeId],
      },
      expect: 201,
      covers: ['C02'],
      show: (r) => [
        field(
          'audience badge',
          val(r, 'data', 'visibility') + ' (UI label: Editor)'
        ),
      ],
    });
    s.ids.draft = num(draft, 'data', 'id');
    s.stories.push(s.ids.draft);

    // external links
    const l1 = await w.step({
      who: elena,
      say: 'adds an external link to the story',
      method: 'POST',
      path: `/v2/stories/${storyId}/external-links`,
      json: { url: 'https://example.test/river-history' },
      expect: 201,
      covers: ['V16', 'M13'],
      show: (r) => [field('link', val(r, 'data', 'url'))],
    });
    const l2 = await w.step({
      who: elena,
      say: 'adds a second external link',
      method: 'POST',
      path: `/v2/stories/${storyId}/external-links`,
      json: { url: 'https://example.test/river-song' },
      expect: 201,
      covers: ['V16'],
    });
    const link1 = num(l1, 'data', 'id');
    const link2 = num(l2, 'data', 'id');
    await w.step({
      who: elena,
      say: 'puts the second link first',
      method: 'PATCH',
      path: `/v2/stories/${storyId}/external-links/reorder`,
      json: { linkIds: [link2, link1] },
      expect: 200,
      covers: ['V16'],
    });
    await w.step({
      who: elena,
      say: 'rejects a javascript: link',
      method: 'POST',
      path: `/v2/stories/${storyId}/external-links`,
      json: { url: 'javascript:alert(1)' },
      expect: 400,
      negative: true,
      covers: ['V16'],
      show: 'the link field says only http and https links are allowed',
    });
    await w.step({
      who: elena,
      say: 'removes the first link',
      method: 'DELETE',
      path: `/v2/stories/${storyId}/external-links/${link1}`,
      expect: 204,
      covers: ['V16'],
    });
    await w.step({
      who: elena,
      say: 'opens the story to check the link is shown to readers',
      method: 'GET',
      path: `/v2/stories/${storyId}`,
      expect: 200,
      covers: ['M13', 'B10'],
      check: (r) =>
        ((val(r, 'data', 'externalMediaLinks') as unknown[]) ?? []).length === 1
          ? undefined
          : 'expected exactly one external link',
      show: (r) => [
        field(
          'external links',
          ((val(r, 'data', 'externalMediaLinks') as unknown[]) ?? []).length
        ),
      ],
    });

    // ---- reading as an editor -------------------------------------------
    await w.step({
      who: elena,
      say: 'opens the stories list and filters by place and speaker',
      method: 'GET',
      path: `/v2/stories?place=${placeId}&speaker=${speakerId}&sort=title_asc&limit=10`,
      expect: 200,
      covers: ['B09', 'M05', 'M06'],
      check: (r) =>
        ((dig(r, 'data', 'stories') as unknown[]) ?? []).length >= 1
          ? undefined
          : 'the story is missing from the filtered list',
      show: (r) => [
        field('stories', dig(r, 'meta', 'total')),
        'cards show title, audience badge and first place',
      ],
    });
    await w.step({
      who: elena,
      say: 'types the run id in the search box',
      method: 'GET',
      path: `/v2/stories?search=${encodeURIComponent(w.runId)}`,
      expect: 200,
      covers: ['B06'],
      show: (r) => [field('matches', dig(r, 'meta', 'total'))],
    });
    await w.step({
      who: elena,
      say: 'opens the place page and its stories',
      method: 'GET',
      path: `/v2/places/${placeId}`,
      expect: 200,
      covers: ['B12', 'M04'],
      show: (r) => [
        field('name', val(r, 'data', 'name')),
        field('photos', ((val(r, 'data', 'photos') as unknown[]) ?? []).length),
        field(
          'name audio',
          val(r, 'data', 'placenameAudio') ? 'yes (play button)' : 'none'
        ),
      ],
    });
    await w.step({
      who: elena,
      say: 'asks for the stories at that place',
      method: 'GET',
      path: `/v2/stories?place=${placeId}`,
      expect: 200,
      covers: ['B12'],
    });
    await w.step({
      who: elena,
      say: 'browses the places list',
      method: 'GET',
      path: '/v2/places?limit=10',
      expect: 200,
      covers: ['B11'],
      show: (r) => [field('places', dig(r, 'meta', 'total'))],
    });
    await w.step({
      who: elena,
      say: 'asks which places are near a point (nearby places)',
      method: 'GET',
      path: '/v2/places?near=6.8,-58.15,5',
      expect: 200,
      covers: ['V19'],
      check: (r) =>
        ((val(r, 'data') as Array<{ id: number }>) ?? []).some(
          (p) => p.id === placeId
        )
          ? undefined
          : 'the place is not found near its own coordinates',
      show: (r) => [
        field(
          'places within 5 km',
          ((val(r, 'data') as unknown[]) ?? []).length
        ),
      ],
    });
    await w.step({
      who: elena,
      say: 'asks for places inside a bounding box',
      method: 'GET',
      path: '/v2/places?bbox=-59,6,-58,7.5',
      expect: 200,
      covers: ['V19'],
    });
    await w.step({
      who: elena,
      say: 'opens the speakers list',
      method: 'GET',
      path: '/v2/speakers?limit=10',
      expect: 200,
      covers: ['B13'],
    });
    await w.step({
      who: elena,
      say: 'opens the speaker page and the stories they appear in',
      method: 'GET',
      path: `/v2/speakers/${speakerId}`,
      expect: 200,
      covers: ['B14'],
      show: (r) => [
        field('name', val(r, 'data', 'name')),
        field('birthdate', val(r, 'data', 'birthDate')),
        field('birthplace', dig(r, 'data', 'birthplace', 'name')),
      ],
    });
    await w.step({
      who: elena,
      say: 'lists the stories of that speaker',
      method: 'GET',
      path: `/v2/stories?speaker=${speakerId}`,
      expect: 200,
      covers: ['B14'],
    });

    // media metadata/detach for place and speaker
    await w.step({
      who: elena,
      say: 'removes the place-name audio',
      method: 'DELETE',
      path: `/v2/attachments/${s.attachments.placeAudio}`,
      expect: 204,
      covers: ['C12'],
    });
    await w.step({
      who: elena,
      say: 'clears the now-unused file out of storage',
      method: 'DELETE',
      path: `/v2/media/${s.files.placeAudio}`,
      expect: [204, 404],
      covers: ['V18'],
    });
    await w.step({
      who: elena,
      say: 'removes the place photo',
      method: 'DELETE',
      path: `/v2/attachments/${s.attachments.placePhoto}`,
      expect: 204,
      covers: ['C13'],
    });
    await w.step({
      who: elena,
      say: 'clears the now-unused file out of storage',
      method: 'DELETE',
      path: `/v2/media/${s.files.placePhoto}`,
      expect: [204, 404],
      covers: ['V18'],
    });
    await w.step({
      who: elena,
      say: 'removes the speaker portrait (the default avatar returns)',
      method: 'DELETE',
      path: `/v2/attachments/${s.attachments.speakerPhoto}`,
      expect: 204,
      covers: ['C21'],
    });
    await w.step({
      who: elena,
      say: 'clears the now-unused file out of storage',
      method: 'DELETE',
      path: `/v2/media/${s.files.speakerPhoto}`,
      expect: [204, 404],
      covers: ['V18'],
    });

    // ---- negatives ----------------------------------------------------
    await w.step({
      who: elena,
      say: 'tries the Users screen',
      method: 'GET',
      path: '/v2/users',
      expect: 403,
      negative: true,
      covers: ['D01'],
      show: 'there is no Users entry in the editor menu',
    });
    await w.step({
      who: elena,
      say: 'tries to change the map settings',
      method: 'PUT',
      path: '/v2/community/map-config',
      json: { centerLatitude: 1, centerLongitude: 1 },
      expect: 403,
      negative: true,
      covers: ['D06'],
    });
    await w.step({
      who: elena,
      say: 'tries to export the community',
      method: 'POST',
      path: '/v2/community/export',
      json: {},
      expect: 403,
      negative: true,
      covers: ['V01'],
    });

    // ---- imports ------------------------------------------------------
    await importChapter(ctx, placeId, speakerId);

    // ---- deletes of temporary content ------------------------------------
    const tmpPlace = await w.step({
      who: elena,
      say: 'creates a temporary place to delete',
      method: 'POST',
      path: '/v2/places',
      json: { name: `${w.runId} Temporary place` },
      expect: 201,
      covers: ['C14'],
    });
    const tmpSpeaker = await w.step({
      who: elena,
      say: 'creates a temporary speaker to delete',
      method: 'POST',
      path: '/v2/speakers',
      json: { name: `${w.runId} Temporary speaker` },
      expect: 201,
      covers: ['C22'],
    });
    const tmpStory = await w.step({
      who: elena,
      say: 'creates a temporary story to delete',
      method: 'POST',
      path: '/v2/stories',
      json: { title: `${w.runId} Temporary story`, visibility: 'editors' },
      expect: 201,
      covers: ['C06'],
      show: (r) => [
        'a story with no place is shown as "incomplete" and is not on the map (D03)',
        field('places', ((val(r, 'data', 'places') as unknown[]) ?? []).length),
      ],
    });
    await w.step({
      who: elena,
      say: 'deletes the temporary story (confirm dialog)',
      method: 'DELETE',
      path: `/v2/stories/${num(tmpStory, 'data', 'id')}`,
      expect: 204,
      covers: ['C06'],
    });
    await w.step({
      who: elena,
      say: 'deletes the temporary place (confirm dialog)',
      method: 'DELETE',
      path: `/v2/places/${num(tmpPlace, 'data', 'id')}`,
      expect: 204,
      covers: ['C14'],
    });
    await w.step({
      who: elena,
      say: 'deletes the temporary speaker (confirm dialog)',
      method: 'DELETE',
      path: `/v2/speakers/${num(tmpSpeaker, 'data', 'id')}`,
      expect: 204,
      covers: ['C22'],
    });
    await w.step({
      who: elena,
      say: 'opens the deleted story again',
      method: 'GET',
      path: `/v2/stories/${num(tmpStory, 'data', 'id')}`,
      expect: 404,
      negative: true,
      covers: ['C06'],
    });
  });
}

async function importChapter(
  ctx: Ctx,
  placeId: number,
  speakerId: number
): Promise<void> {
  const { w, s } = ctx;
  const elena = s.actors.elena!;
  const csv = (text: string) => new TextEncoder().encode(text);
  const form = (
    kind: string,
    rows: string,
    extra: Record<string, string> = {},
    media: Array<{
      field: string;
      name: string;
      type: string;
      bytes: Uint8Array;
    }> = []
  ) =>
    multipart(
      { kind, ...extra },
      { name: `${w.runId}-${kind}.csv`, type: 'text/csv', bytes: csv(rows) },
      media
    );

  const preview = await w.step({
    who: elena,
    say: 'picks a places CSV with differently named columns; the page shows the column-mapping table and she maps "Place name" and "Area"',
    method: 'POST',
    path: '/v2/imports/preview',
    form: form(
      'places',
      `Place name,Area,photo\n${w.runId} Import landing,East,${w.runId}-imp.png\n${w.runId} Import bend,West,\n`,
      {
        mappings: JSON.stringify({
          name: 'Place name',
          region: 'Area',
          photo: 'photo',
        }),
      },
      [
        {
          field: 'media',
          name: `${w.runId}-imp.png`,
          type: 'image/png',
          bytes: PNG_BYTES,
        },
      ]
    ),
    bodyNote: 'multipart: kind=places, mappings, one CSV, one staged image',
    expect: 201,
    covers: ['C30'],
    show: (r) => [
      field('status', val(r, 'data', 'status')),
      field('rows', val(r, 'data', 'rowCount')),
      field('staged media', val(r, 'data', 'stagedMediaCount')),
      field('can commit', val(r, 'data', 'canCommit')),
    ],
  });
  const manifest = num(preview, 'data', 'id');
  s.imports.push(manifest);
  await w.step({
    who: elena,
    say: 'reads the preview again (the review page)',
    method: 'GET',
    path: `/v2/imports/${manifest}`,
    expect: 200,
    covers: ['C32'],
    show: (r) => [
      field('status', val(r, 'data', 'status')),
      field(
        'row errors',
        ((val(r, 'data', 'rowErrors') as unknown[]) ?? []).length
      ),
    ],
  });
  await w.step({
    who: elena,
    say: 'submits the import; it is applied all-or-nothing',
    method: 'POST',
    path: `/v2/imports/${manifest}/commit`,
    expect: [200, 201],
    covers: ['C31'],
    show: (r) => [
      field('status', val(r, 'data', 'status')),
      field('result', JSON.stringify(val(r, 'data', 'resultSummary') ?? {})),
    ],
  });
  await w.step({
    who: elena,
    say: 'opens the places list to see the imported places',
    method: 'GET',
    path: '/v2/places?limit=100',
    expect: 200,
    covers: ['C31'],
    check: (r) => {
      const names = ((val(r, 'data') as Array<{ name: string }>) ?? []).map(
        (p) => p.name
      );
      return [`${w.runId} Import landing`, `${w.runId} Import bend`].every(
        (n) => names.includes(n)
      )
        ? undefined
        : 'the committed import did not create both places';
    },
    show: (r) => [
      field('places found', ((val(r, 'data') as unknown[]) ?? []).length),
    ],
  });
  // places created by the import are removed in cleanup by name prefix
  const stories = await w.step({
    who: elena,
    say: 'prepares a stories CSV whose audience column holds "Everyone" and "Members"; she maps them to Anonymous and Member in the audience-mapping step',
    method: 'POST',
    path: '/v2/imports/preview',
    form: form(
      'stories',
      `title,audience,placeNames\n${w.runId} Imported open story,Everyone,${w.runId} Import landing\n${w.runId} Imported members story,Members,${w.runId} Import bend\n`,
      {
        audienceMapping: JSON.stringify({
          Everyone: 'public',
          Members: 'community',
        }),
      }
    ),
    bodyNote: 'multipart: kind=stories, audienceMapping, one CSV',
    expect: 201,
    covers: ['C30'],
    show: (r) => [
      field('rows', val(r, 'data', 'rowCount')),
      field(
        'audience counts',
        JSON.stringify(dig(r, 'data', 'audienceCounts') ?? {})
      ),
    ],
  });
  const storiesManifest = num(stories, 'data', 'id');
  s.imports.push(storiesManifest);
  await w.step({
    who: elena,
    say: 'commits the stories import',
    method: 'POST',
    path: `/v2/imports/${storiesManifest}/commit`,
    expect: [200, 201],
    covers: ['C31'],
  });
  await w.step({
    who: elena,
    say: 'opens the stories list to see the imported stories',
    method: 'GET',
    path: `/v2/stories?search=${encodeURIComponent(w.runId + ' Imported')}&limit=50`,
    expect: 200,
    covers: ['C31'],
    check: (r) => {
      const titles = (
        (dig(r, 'data', 'stories') as Array<{ title: string }>) ?? []
      ).map((x) => x.title);
      return [
        `${w.runId} Imported open story`,
        `${w.runId} Imported members story`,
      ].every((t) => titles.includes(t))
        ? undefined
        : 'the committed import did not create both stories';
    },
  });
  const bad = await w.step({
    who: elena,
    say: 'previews a speakers CSV with a bad birth date, to see the invalid-rows table',
    method: 'POST',
    path: '/v2/imports/preview',
    form: form(
      'speakers',
      `name,birthDate\n${w.runId} Import speaker,not-a-date\n`
    ),
    expect: [201, 400, 422],
    covers: ['C32'],
    show: (r) => [
      field('status', val(r, 'data', 'status')),
      field('can commit', val(r, 'data', 'canCommit')),
      'the invalid rows table lists row, field and reason, with "Download invalid rows as CSV"',
    ],
  });
  const badId = val(bad, 'data', 'id');
  if (typeof badId === 'number') s.imports.push(badId);
  w.narrate(
    'Elena leaves that preview open for now; she discards the open previews when she tidies up at the end of the day.'
  );
  await w.step({
    who: elena,
    say: 'opens the list of imports',
    method: 'GET',
    path: '/v2/imports',
    expect: 200,
    covers: ['C32'],
    show: (r) => [
      field(
        'imports',
        dig(r, 'meta', 'total') ?? ((val(r, 'data') as unknown[]) ?? []).length
      ),
    ],
  });
  const d = await w.step({
    who: elena,
    say: 'starts another places import and walks away; she discards it',
    method: 'POST',
    path: '/v2/imports/preview',
    form: form('places', `name\n${w.runId} Discarded place\n`),
    expect: 201,
    covers: ['C30'],
  });
  s.imports.push(num(d, 'data', 'id'));
  void placeId;
  void speakerId;
  void str;
}
