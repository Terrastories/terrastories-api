/**
 * The reader screens every signed-in reader persona uses (handoff B06-B14,
 * M01-M09, M12): map, filters, story, place, speaker, media.
 */
import type { Actor } from '../client.js';
import { dig } from '../walk.js';
import { field, val, type Ctx } from '../context.js';

export interface TourOptions {
  /** Titles (by suffix after the run id) this reader must see. */
  mustSee: string[];
  /** Titles this reader must not see. */
  mustNotSee: string[];
  /** Draft story id that must be hidden (404). */
  hiddenStoryId?: number;
}

const titlesOf = (reply: { json: unknown }): string[] =>
  (((dig({ json: reply.json } as never, 'data', 'stories') as Array<{ title: string }>) ?? [])).map((s) => s.title);

export async function readerTour(
  ctx: Ctx,
  who: Actor,
  options: TourOptions
): Promise<void> {
  const { w, s } = ctx;
  const place = s.ids.place!;
  const speaker = s.ids.speaker!;
  const story = s.ids.story!;
  const page = await w.step({
    who,
    say: 'opens the map: the stories she may read and the place markers load together',
    method: 'GET',
    path: `/v2/stories?search=${encodeURIComponent(w.runId)}&limit=50`,
    expect: 200,
    covers: ['M01', 'B09', 'B06'],
    check: (r) => {
      const titles = titlesOf(r);
      for (const t of options.mustSee)
        if (!titles.some((x) => x.includes(t))) return `expected to see "${t}"`;
      for (const t of options.mustNotSee)
        if (titles.some((x) => x.includes(t))) return `must not see "${t}"`;
    },
    show: (r) => [
      field('story cards', titlesOf(r).length),
      field('map markers', ((dig(r, 'data', 'points') as unknown[]) ?? []).length),
      ...titlesOf(r).slice(0, 4).map((t) => `card: ${t}`),
    ],
  });
  void page;
  await w.step({
    who,
    say: 'reads the map settings for the base map',
    method: 'GET',
    path: '/v2/community/map-config',
    expect: 200,
    covers: ['M02'],
    show: (r) => [field('base map source', dig(r, 'render', 'source'))],
  });
  await w.step({
    who,
    say: 'filters the map by place and speaker, sorted A-Z',
    method: 'GET',
    path: `/v2/stories?place=${place}&speaker=${speaker}&sort=title_asc`,
    expect: 200,
    covers: ['M05', 'M06', 'B09'],
    show: (r) => [field('stories after filter', dig(r, 'meta', 'total'))],
  });
  await w.step({
    who,
    say: 'sorts the cards Z-A',
    method: 'GET',
    path: `/v2/stories?search=${encodeURIComponent(w.runId)}&sort=title_desc`,
    expect: 200,
    covers: ['M06'],
  });
  await w.step({
    who,
    say: 'clicks a place marker to open its popup',
    method: 'GET',
    path: `/v2/places/${place}`,
    expect: 200,
    covers: ['M04', 'B12'],
    show: (r) => [field('place', val(r, 'data', 'name')), field('region', val(r, 'data', 'region'))],
  });
  const detail = await w.step({
    who,
    say: 'clicks a story card: it flies to the first place and shows the full story',
    method: 'GET',
    path: `/v2/stories/${story}`,
    expect: 200,
    covers: ['M07', 'M08', 'B10'],
    show: (r) => [
      field('title', val(r, 'data', 'title')),
      field('language', val(r, 'data', 'language')),
      field('speakers', ((val(r, 'data', 'speakers') as Array<{ name: string }>) ?? []).map((x) => x.name).join(', ')),
      field('media items', ((val(r, 'data', 'attachments') as unknown[]) ?? []).length),
      field('external links', ((val(r, 'data', 'externalMediaLinks') as unknown[]) ?? []).length),
    ],
  });
  const attachment = ((dig(detail, 'data', 'attachments') as Array<{ url?: string }>) ?? [])[0];
  if (attachment?.url) {
    await w.step({
      who,
      say: 'presses play on the story media; the browser asks for the first bytes only',
      method: 'GET',
      path: attachment.url,
      headers: { range: 'bytes=0-7' },
      expect: [200, 206],
      covers: ['M09'],
      show: (r) => [field('status', r.status === 206 ? '206 partial content (seekable)' : '200 full content'), field('content type', r.headers.get('content-type'))],
    });
  } else {
    w.narrate('The story has no media attachment to play.');
  }
  await w.step({
    who,
    say: 'browses the places list',
    method: 'GET',
    path: '/v2/places?limit=20',
    expect: 200,
    covers: ['B11'],
  });
  await w.step({
    who,
    say: 'opens the speakers list',
    method: 'GET',
    path: '/v2/speakers?limit=20',
    expect: 200,
    covers: ['B13'],
  });
  await w.step({
    who,
    say: 'opens a speaker page and their stories',
    method: 'GET',
    path: `/v2/speakers/${speaker}`,
    expect: 200,
    covers: ['B14'],
    show: (r) => [field('speaker', val(r, 'data', 'name')), field('community', val(r, 'data', 'affiliation'))],
  });
  await w.step({
    who,
    say: 'lists the stories of that speaker',
    method: 'GET',
    path: `/v2/stories?speaker=${speaker}`,
    expect: 200,
    covers: ['B14'],
  });
  await w.step({
    who,
    say: 'shows "Hello name" in the card footer',
    method: 'GET',
    path: '/v2/auth/me',
    expect: 200,
    covers: ['M12', 'B08'],
    show: (r) => [field('Hello', val(r, 'user', 'displayName'))],
  });
  if (options.hiddenStoryId !== undefined) {
    await w.step({
      who,
      say: 'follows a link to the editors-only draft',
      method: 'GET',
      path: `/v2/stories/${options.hiddenStoryId}`,
      expect: 404,
      negative: true,
      covers: ['B10'],
      show: 'the page says the story is not found, not that it exists',
    });
  }
}

export async function readerNegatives(ctx: Ctx, who: Actor, covers: { content: string[] }): Promise<void> {
  const { w } = ctx;
  const refuse = (say: string, method: string, path: string, json: unknown, rows: string[]) =>
    w.step({ who, say, method, path, json, expect: 403, negative: true, covers: rows });
  await refuse('tries to write a story', 'POST', '/v2/stories', { title: 'nope' }, covers.content);
  await refuse('tries to open the Users screen', 'GET', '/v2/users', undefined, ['D01']);
  await refuse('tries to change the map settings', 'PUT', '/v2/community/map-config', { centerLatitude: 1, centerLongitude: 1 }, ['D06']);
  await refuse('tries to change community settings', 'PATCH', '/v2/community', { name: 'nope' }, ['D08']);
  await refuse('tries to open the CSV import', 'GET', '/v2/imports', undefined, ['C30']);
  await refuse('tries to export the community', 'POST', '/v2/community/export', {}, ['V01']);
  await refuse('tries the sovereignty page', 'GET', '/v2/community/sovereignty', undefined, ['V02']);
  await refuse('tries the audit log', 'GET', '/v2/community/audit-entries', undefined, ['V12']);
}
