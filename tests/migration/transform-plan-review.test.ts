import { describe, expect, it } from 'vitest';
import type {
  SourceRow,
  VerifiedBundle,
} from '../../src/migration/v2/bundle-reader.js';
import { planTransform } from '../../src/migration/v2/plan.js';

const BCRYPT = '$2b$10$' + 'abcdefghijklmnopqrstuu' + 'A'.repeat(31);
const STAMP = '2024-01-02 03:04:05';

type Tables = Record<string, SourceRow[]>;

function bundleOf(
  tables: Tables,
  manifest: {
    complete?: boolean;
    captured?: Array<{ id: string; slug: string | null }>;
  } = {}
): VerifiedBundle {
  const complete = manifest.complete ?? true;
  return {
    dir: '/nonexistent',
    manifestSha256: 'x',
    manifest: {
      complete,
      blobSelection: {
        mode: complete ? 'all' : 'community_allowlist',
        selectors: [],
        communities: manifest.captured ?? [],
      },
      tables: {},
      blobs: [],
    },
    tableNames: Object.keys(tables).sort(),
    rows: (table: string) => tables[table] ?? [],
    close: () => undefined,
  } as unknown as VerifiedBundle;
}

const community = (id: string, slug: string): SourceRow => ({
  id,
  name: 'Community ' + id,
  slug,
  description: null,
  public: 'true',
  locale: 'en',
  country: null,
  beta: 'false',
  created_at: STAMP,
  updated_at: STAMP,
});

const user = (
  id: string,
  communityId: string | null,
  extra: Partial<SourceRow> = {}
): SourceRow => ({
  id,
  email: 'u' + id + '@example.test',
  username: 'user' + id,
  name: null,
  role: communityId === null ? '100' : '2',
  super_admin: communityId === null ? 'true' : 'false',
  community_id: communityId,
  encrypted_password: BCRYPT,
  created_at: STAMP,
  updated_at: STAMP,
  ...extra,
});

const story = (id: string, communityId: string): SourceRow => ({
  id,
  title: 'Story ' + id,
  desc: null,
  language: 'en',
  permission_level: '0',
  community_id: communityId,
  date_interviewed: null,
  interview_location_id: null,
  interviewer_id: null,
  created_at: STAMP,
  updated_at: STAMP,
});

const count = (
  plan: ReturnType<typeof planTransform>,
  table: string,
  status: 'archived' | 'not_selected'
): number => plan.statusCounts[table]?.[status] ?? 0;

describe('partial bundle guard', () => {
  const tables: Tables = {
    communities: [community('1', 'one'), community('2', 'two')],
  };
  const partial = (): VerifiedBundle =>
    bundleOf(tables, { complete: false, captured: [{ id: '1', slug: 'one' }] });

  it('refuses a full run over a partial capture', () => {
    expect(() => planTransform(partial())).toThrow(/partial capture/);
  });

  it('refuses a selection outside the captured selection', () => {
    expect(() => planTransform(partial(), { communities: ['two'] })).toThrow(
      /outside the partial bundle capture/
    );
    expect(() =>
      planTransform(partial(), { communities: ['one', '2'] })
    ).toThrow(/outside the partial bundle capture/);
  });

  it('accepts a subset of the captured selection', () => {
    const plan = planTransform(partial(), { communities: ['one'] });
    expect(plan.canonical.communities.map((c) => c.id)).toEqual([1]);
  });

  it('still allows a full run over a complete bundle', () => {
    const plan = planTransform(bundleOf(tables));
    expect(plan.canonical.communities).toHaveLength(2);
  });
});

describe('curriculum archiving', () => {
  const tables: Tables = {
    communities: [community('1', 'one'), community('2', 'two')],
    users: [user('10', '1'), user('11', '2'), user('12', null)],
    stories: [story('50', '1'), story('51', '2')],
    curriculums: [
      { id: '1', user_id: '10' },
      { id: '2', user_id: '11' },
      { id: '3', user_id: '12' },
      { id: '4', user_id: '999' },
      { id: '5', user_id: null },
    ],
    curriculum_stories: [
      { id: '1', curriculum_id: '1', story_id: '50' },
      { id: '2', curriculum_id: '2', story_id: '51' },
      { id: '3', curriculum_id: '3', story_id: '50' },
      { id: '4', curriculum_id: '4', story_id: null },
    ],
  };

  it('archives every curriculum and link in a full run, owner or not', () => {
    const plan = planTransform(bundleOf(tables));
    expect(count(plan, 'curriculums', 'archived')).toBe(5);
    expect(count(plan, 'curriculums', 'not_selected')).toBe(0);
    expect(count(plan, 'curriculum_stories', 'archived')).toBe(4);
  });

  it('archives only selected-community curriculums in a scoped run', () => {
    const plan = planTransform(bundleOf(tables), { communities: ['one'] });
    expect(count(plan, 'curriculums', 'archived')).toBe(1);
    expect(count(plan, 'curriculums', 'not_selected')).toBe(4);
    // link 1 (curriculum archived) and link 3 (story in community 1) archive
    expect(count(plan, 'curriculum_stories', 'archived')).toBe(2);
    expect(count(plan, 'curriculum_stories', 'not_selected')).toBe(2);
  });
});

describe('null-community users', () => {
  const tables: Tables = {
    communities: [community('1', 'one')],
    users: [
      user('10', '1'),
      user('12', null),
      user('13', null, { role: '2', super_admin: 'false' }),
    ],
  };

  it('full run archives a super_admin and flags other null-community users MANUAL', () => {
    const plan = planTransform(bundleOf(tables));
    expect(plan.canonical.users.map((u) => u.id)).toEqual([10]);
    expect(count(plan, 'users', 'archived')).toBe(1);
    expect(plan.manual).toContainEqual({
      table: 'users',
      id: '13',
      code: 'null_community_user',
    });
    const archived = plan.archivedRows.map((r) => r.table + '#' + r.id);
    expect(archived).toEqual(expect.arrayContaining(['users#12', 'users#13']));
  });

  it('scoped run keeps not_selected with a warning', () => {
    const plan = planTransform(bundleOf(tables), { communities: ['one'] });
    expect(count(plan, 'users', 'not_selected')).toBe(2);
    expect(plan.manual).toEqual([]);
  });
});

describe('external media links', () => {
  const link = (id: string, url: string | null): SourceRow => ({
    id,
    story_id: '50',
    url,
    created_at: STAMP,
    updated_at: STAMP,
  });
  const tables: Tables = {
    communities: [community('1', 'one')],
    stories: [story('50', '1')],
    media_links: [
      link('1', 'https://example.test/a'),
      link('2', 'javascript:alert(1)'),
      link('3', 'not a url'),
      link('4', 'https://example.test/' + 'a'.repeat(2048)),
      link('5', 'ftp://example.test/file'),
    ],
  };

  it('imports safe links; unsafe or over-long ones are MANUAL with the raw row archived', () => {
    const plan = planTransform(bundleOf(tables));
    expect(plan.canonical.external_media_links.map((l) => l.id)).toEqual([1]);
    expect(
      plan.manual
        .filter((m) => m.table === 'media_links')
        .map((m) => m.id + ':' + m.code)
    ).toEqual([
      '2:url_invalid',
      '3:url_invalid',
      '4:url_invalid',
      '5:url_invalid',
    ]);
    const archived = plan.archivedRows.filter((r) => r.table === 'media_links');
    expect(archived.map((r) => r.row.url)).toContain('javascript:alert(1)');
  });
});

describe('super_admin email collisions', () => {
  it('flags a null-community super_admin sharing an email with a community user', () => {
    const plan = planTransform(
      bundleOf({
        communities: [community('1', 'one')],
        users: [
          user('10', '1', { email: 'Shared@Example.test' }),
          user('12', null, { email: 'shared@example.test' }),
        ],
      }),
      { includeSystemUsers: true }
    );
    expect(plan.canonical.users).toHaveLength(0);
    expect(plan.manual.map((m) => m.id + ':' + m.code)).toEqual([
      '10:super_admin_email_collision',
      '12:super_admin_email_collision',
    ]);
  });

  it('does not flag distinct emails', () => {
    const plan = planTransform(
      bundleOf({
        communities: [community('1', 'one')],
        users: [user('10', '1'), user('12', null)],
      }),
      { includeSystemUsers: true }
    );
    expect(plan.canonical.users).toHaveLength(2);
  });
});

describe('over-length descriptions', () => {
  it('is a MANUAL code, not a warning', () => {
    const long = '<p>' + 'a'.repeat(60000) + '</p>';
    const plan = planTransform(
      bundleOf({
        communities: [{ ...community('1', 'one'), description: long }],
      })
    );
    expect(plan.manual).toContainEqual({
      table: 'communities',
      id: '1',
      code: 'description_exceeds_max_length',
    });
    expect(plan.warnings.map((w) => w.code)).not.toContain(
      'description_exceeds_max_length'
    );
  });
});

describe('story slug', () => {
  it('matches the runtime slug base', () => {
    const plan = planTransform(
      bundleOf({
        communities: [community('1', 'one')],
        stories: [{ ...story('50', '1'), title: 'Olá Mundo: A  História!' }],
      })
    );
    expect(plan.canonical.stories[0]?.slug).toBe('ola-mundo-a-historia-50');
  });
});

describe('media reachability', () => {
  const blob = (id: string) => ({
    id,
    key: 'k' + id,
    byteSize: '1',
    sha256: 'x',
    disposition: 'captured',
  });
  const att = (
    id: string,
    type: string,
    recordId: string,
    blobId: string,
    name = 'file'
  ): SourceRow => ({
    id,
    record_type: type,
    record_id: recordId,
    blob_id: blobId,
    name,
  });
  const make = () => {
    const bundle = bundleOf({
      communities: [community('1', 'one'), community('2', 'two')],
      stories: [story('50', '1'), story('51', '2')],
      media: [
        { id: '1', story_id: '50' },
        { id: '2', story_id: '51' },
      ],
      active_storage_blobs: [],
      active_storage_attachments: [
        att('1', 'Media', '1', '100'),
        att('2', 'Media', '2', '200'),
        att('3', 'ActiveStorage::Blob', '100', '101', 'preview_image'),
        att('4', 'ActiveStorage::VariantRecord', '1', '102', 'image'),
      ],
      active_storage_variant_records: [{ id: '1', blob_id: '101' }],
    });
    (bundle.manifest as unknown as { blobs: unknown[] }).blobs = [
      blob('100'),
      blob('101'),
      blob('102'),
      blob('200'),
    ];
    return bundle;
  };

  it('scoped run: blobs follow the transform selection, derived chains included', () => {
    const plan = planTransform(make(), { communities: ['one'] });
    const status = Object.fromEntries(
      plan.pendingMedia.blobs.map((b) => [b.id, b.status])
    );
    expect(status).toEqual({
      '100': 'pending_media_slice',
      '101': 'pending_media_slice',
      '102': 'pending_media_slice',
      '200': 'not_selected',
    });
    expect(
      plan.pendingMedia.blobs.every((b) => b.bundleDisposition === 'captured')
    ).toBe(true);
    const attachments = Object.fromEntries(
      plan.pendingMedia.attachments.map((a) => [a.id, a.status])
    );
    expect(attachments).toEqual({
      '1': 'pending_media_slice',
      '2': 'not_selected',
      '3': 'pending_media_slice',
      '4': 'pending_media_slice',
    });
    expect(plan.manual).toEqual([]);
  });

  it('full run: every captured blob stays pending and chains are attributed', () => {
    const plan = planTransform(make());
    expect(
      plan.pendingMedia.blobs.every((b) => b.status === 'pending_media_slice')
    ).toBe(true);
    expect(plan.manual).toEqual([]);
  });
});

describe('media bytes not captured', () => {
  const bundle = () => {
    const b = bundleOf(
      {
        communities: [community('1', 'one')],
        users: [user('10', '1'), user('12', null)],
        stories: [story('50', '1')],
        media: [{ id: '1', story_id: '50' }],
        active_storage_attachments: [
          {
            id: '1',
            record_type: 'Media',
            record_id: '1',
            blob_id: '100',
            name: 'file',
          },
          {
            id: '2',
            record_type: 'User',
            record_id: '12',
            blob_id: '200',
            name: 'avatar',
          },
        ],
      },
      { complete: false, captured: [{ id: '1', slug: 'one' }] }
    );
    (b.manifest as unknown as { blobs: unknown[] }).blobs = [
      {
        id: '100',
        key: 'k',
        byteSize: '1',
        sha256: 'x',
        disposition: 'captured',
      },
      {
        id: '200',
        key: 'k2',
        byteSize: '1',
        sha256: null,
        disposition: 'not_selected',
      },
    ];
    return b;
  };

  it('is MANUAL for a selected system-user attachment whose blob was not captured', () => {
    const plan = planTransform(bundle(), {
      communities: ['one'],
      includeSystemUsers: true,
    });
    expect(plan.manual).toContainEqual({
      table: 'active_storage_attachments',
      id: '2',
      code: 'media_bytes_not_captured',
    });
    const statuses = Object.fromEntries(
      plan.pendingMedia.attachments.map((a) => [a.id, a.status])
    );
    expect(statuses).toEqual({ '1': 'pending_media_slice' });
  });

  it('stays not_selected without --include-system-users', () => {
    const plan = planTransform(bundle(), { communities: ['one'] });
    expect(plan.manual).toEqual([]);
    expect(
      plan.pendingMedia.attachments.find((a) => a.id === '2')?.status
    ).toBe('not_selected');
  });
});

describe('archive keys for tables without an id column', () => {
  it('keys unregistered-column archives by the natural key / ordinal', () => {
    const b = bundleOf({
      schema_migrations: [
        { version: '20240101', extra: 'a' },
        { version: '20240102', extra: 'b' },
      ],
      ar_internal_metadata: [
        { key: 'environment', extra: 'c' },
        { key: 'schema_sha1', extra: 'd' },
      ],
    });
    (b.manifest as unknown as { tables: unknown }).tables = {
      schema_migrations: {
        rowCount: 2,
        columns: [{ columnName: 'version' }, { columnName: 'extra' }],
      },
      ar_internal_metadata: {
        rowCount: 2,
        columns: [{ columnName: 'key' }, { columnName: 'extra' }],
      },
    };
    const plan = planTransform(b);
    const fields = plan.archivedFields.filter((f) => f.column === 'extra');
    expect(
      fields.map((f) => f.table + '#' + f.id + '=' + f.value).sort()
    ).toEqual([
      'ar_internal_metadata#environment=c',
      'ar_internal_metadata#schema_sha1=d',
      'schema_migrations#20240101=a',
      'schema_migrations#20240102=b',
    ]);
  });
});

describe('community selector resolution', () => {
  const tables: Tables = {
    communities: [
      community('5', 'alpha'),
      community('7', '5'),
      community('8', 'dup'),
      community('9', 'dup'),
    ],
  };
  it('an existing numeric id wins over another community slug', () => {
    const plan = planTransform(bundleOf(tables), { communities: ['5'] });
    expect(plan.canonical.communities.map((c) => c.id)).toEqual([5]);
  });
  it('falls back to the slug when no community has that id', () => {
    const plan = planTransform(bundleOf(tables), { communities: ['alpha'] });
    expect(plan.canonical.communities.map((c) => c.id)).toEqual([5]);
  });
  it('rejects an ambiguous slug', () => {
    expect(() =>
      planTransform(bundleOf(tables), { communities: ['dup'] })
    ).toThrow(/ambiguous/);
  });
});

describe('media of a non-imported owner', () => {
  it('is excluded_dependency, never pending_media_slice', () => {
    const bad = { ...story('51', '1'), permission_level: '9' };
    const b = bundleOf({
      communities: [community('1', 'one')],
      stories: [story('50', '1'), bad],
      media: [
        { id: '1', story_id: '50' },
        { id: '2', story_id: '51' },
      ],
      active_storage_attachments: [
        {
          id: '1',
          record_type: 'Media',
          record_id: '1',
          blob_id: '100',
          name: 'f',
        },
        {
          id: '2',
          record_type: 'Media',
          record_id: '2',
          blob_id: '101',
          name: 'f',
        },
      ],
    });
    (b.manifest as unknown as { blobs: unknown[] }).blobs = ['100', '101'].map(
      (id) => ({
        id,
        key: 'k' + id,
        byteSize: '1',
        sha256: 'x',
        disposition: 'captured',
      })
    );
    const plan = planTransform(b);
    expect(
      Object.fromEntries(
        plan.pendingMedia.attachments.map((a) => [a.id, a.status])
      )
    ).toEqual({ '1': 'pending_media_slice' });
    expect(plan.manual).toEqual(
      expect.arrayContaining([
        {
          table: 'active_storage_attachments',
          id: '2',
          code: 'media_owner_not_imported',
        },
        { table: 'media', id: '2', code: 'media_owner_not_imported' },
      ])
    );
    expect(plan.statusCounts.media?.excluded_dependency).toBe(1);
    expect(plan.statusCounts.media?.pending_media_slice).toBe(1);
  });
});

describe('unknown tables', () => {
  it('keys custom rows by ordinal so repeated key columns do not collide', () => {
    const plan = planTransform(
      bundleOf({
        custom_settings: [
          { key: 'theme', value: 'a' },
          { key: 'theme', value: 'b' },
        ],
      })
    );
    const ids = plan.archivedRows
      .filter((r) => r.table === 'custom_settings')
      .map((r) => r.id);
    expect(ids).toEqual(['1', '2']);
    expect(plan.statusCounts.custom_settings?.archived).toBe(2);
  });
});

describe('sequence floors', () => {
  it('records max source ids including rows left out of the canonical set', () => {
    const plan = planTransform(
      bundleOf({
        communities: [community('1', 'one'), community('7', 'seven')],
        users: [user('10', '1')],
        stories: [story('50', '1'), story('60', '7')],
      }),
      { communities: ['one'] }
    );
    expect(plan.sequenceFloors.communities).toBe(7);
    expect(plan.sequenceFloors.stories).toBe(60);
    expect(plan.sequenceFloors.users).toBe(10);
  });
});
