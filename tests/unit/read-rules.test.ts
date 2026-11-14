import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_READ_ASSOCIATIONS,
  MEDIA_READ_ASSOCIATIONS,
  READ_RULE_AUTHORITIES,
  READ_RULE_OVERRIDES,
  READ_RULE_OUTCOMES,
  READ_RULE_OWNER_GRANTS,
  READ_RULE_REQUIRED_AUTHORITIES,
  READ_RULE_RESOURCES,
  READ_RULES,
  READ_RULE_VIEWERS,
  STORY_READ_ASSOCIATIONS,
  readRuleOutcome,
  type ReadRuleInput,
  type ReadRuleOutcome,
  type ReadRulePrivacyEvidence,
  type ReadRuleRow,
} from '../../src/policy/read-rules.js';
import {
  STORY_AUDIENCES,
  STORY_AUDIENCE_ROLES,
  V2_COMMUNITY_ROLES,
  type V2CommunityRole,
} from '../../src/shared/authorization/sovereignty-policy.js';

/** All rows of the table, flattened as (label, row) pairs. */
const allRows: Array<[string, ReadRuleRow]> = Object.entries(
  READ_RULES
).flatMap(([resource, rows]) =>
  Object.entries(rows).map(
    ([association, row]) => [`${resource}/${association}`, row] as const
  )
) as Array<[string, ReadRuleRow]>;

/** own-* viewer columns ↔ canonical community roles (§6.2). */
const ownViewerRole: Record<string, V2CommunityRole> = {
  'own-viewer': 'viewer',
  'own-member': 'member',
  'own-editor': 'editor',
  'own-admin': 'admin',
};

describe('§6.4a read-rules table (#190): totality', () => {
  it('declares exactly the §6.4a association rows for each resource', () => {
    expect(Object.keys(READ_RULES.story).sort()).toEqual(
      [...STORY_READ_ASSOCIATIONS].sort()
    );
    expect(Object.keys(READ_RULES.place).sort()).toEqual(
      [...ASSOCIATED_READ_ASSOCIATIONS].sort()
    );
    expect(Object.keys(READ_RULES.speaker).sort()).toEqual(
      [...ASSOCIATED_READ_ASSOCIATIONS].sort()
    );
    expect(Object.keys(READ_RULES.media).sort()).toEqual(
      [...MEDIA_READ_ASSOCIATIONS].sort()
    );
    expect(READ_RULE_RESOURCES).toEqual(['story', 'place', 'speaker', 'media']);
  });

  it('defines every cell: each row carries exactly the viewer columns', () => {
    expect(allRows.length).toBeGreaterThan(0);
    for (const [label, row] of allRows) {
      expect(Object.keys(row).sort(), label).toEqual(
        [...READ_RULE_VIEWERS].sort()
      );
    }
  });

  it('holds only known outcomes in every cell', () => {
    for (const [label, row] of allRows) {
      for (const [viewer, outcome] of Object.entries(row)) {
        expect(
          (READ_RULE_OUTCOMES as readonly string[]).includes(outcome),
          `${label}/${viewer}: ${String(outcome)}`
        ).toBe(true);
      }
    }
  });

  it('fails closed on unknown resources, associations, and viewers', () => {
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-readable-story',
        viewer: 'anonymous-public',
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      })
    ).toBe('with-readable-stories');
    expect(
      readRuleOutcome({
        resource: 'theme',
        association: 'via-readable-story',
        viewer: 'anonymous-public',
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-any-story',
        viewer: 'anonymous-public',
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-readable-story',
        viewer: 'elder',
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-readable-story',
        viewer: '',
        privacyEvidence: 'clear',
        viewerIsOwner: false,
      })
    ).toBe('hidden');
  });
});

describe('§6.4a read-rules table (#190): #162 override', () => {
  it('names exactly every viewer — admins and super admins included', () => {
    expect(
      READ_RULE_OVERRIDES.restrictedOrUnevidencedPrivacy.viewers.slice()
    ).toEqual([...READ_RULE_VIEWERS]);
    expect(READ_RULE_OVERRIDES.restrictedOrUnevidencedPrivacy.outcome).toBe(
      'hidden'
    );
  });

  it('hides every cell for every viewer when restricted or unevidenced', () => {
    for (const evidence of ['restricted', 'unevidenced'] as const) {
      for (const [label, row] of allRows) {
        for (const viewer of Object.keys(row)) {
          expect(
            readRuleOutcome({
              resource: label.split('/')[0],
              association: label.split('/')[1],
              viewer,
              privacyEvidence: evidence,
              viewerIsOwner: false,
            }),
            `${evidence} ${label}/${viewer}`
          ).toBe('hidden');
        }
      }
    }
    // The highest privileges never escape the override (#162 option A).
    expect(
      readRuleOutcome({
        resource: 'story',
        association: 'audience-public',
        viewer: 'own-admin',
        privacyEvidence: 'restricted',
        viewerIsOwner: false,
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'story-less',
        viewer: 'super-admin',
        privacyEvidence: 'unevidenced',
        viewerIsOwner: false,
      })
    ).toBe('hidden');
  });

  it('requires the #162 evidence input and fails closed without it', () => {
    // Cells whose ordinary outcome is NOT hidden: only the override can
    // explain a `hidden` result here.
    const permissive: Array<[string, string, string, ReadRuleOutcome]> = [
      ['story', 'audience-public', 'own-admin', 'visible'],
      [
        'place',
        'via-readable-story',
        'anonymous-public',
        'with-readable-stories',
      ],
      ['media', 'community-branding', 'own-viewer', 'visible'],
    ];
    for (const [resource, association, viewer, ordinary] of permissive) {
      // Undefined and unknown evidence values reach the function through
      // untyped callers and bad data; every one must fail closed.
      for (const evidence of [
        undefined,
        'unknown',
        '',
        null,
        true,
      ] as unknown as ReadRulePrivacyEvidence[]) {
        const input = {
          resource,
          association,
          viewer,
          privacyEvidence: evidence,
        } as ReadRuleInput;
        expect(
          readRuleOutcome(input),
          `${resource}/${association}/${viewer} evidence=${String(evidence)}`
        ).toBe('hidden');
      }
      // The same cell with clear evidence resolves to its ordinary cell —
      // proving the hidden above is the override, not the table.
      expect(
        readRuleOutcome({
          resource,
          association,
          viewer,
          privacyEvidence: 'clear',
          viewerIsOwner: false,
        })
      ).toBe(ordinary);
    }
    // The original fail-open hole: a caller that omits the evidence key
    // entirely (the input is REQUIRED at the type level, so this needs a
    // cast) must still get hidden, never the ordinary cell.
    expect(
      readRuleOutcome({
        resource: 'story',
        association: 'audience-public',
        viewer: 'own-admin',
      } as ReadRuleInput)
    ).toBe('hidden');
  });
});

describe('§6.4a read-rules table (#190): §6.7 authority qualifiers', () => {
  const profileMedia = (viewerAuthorities?: readonly string[]) =>
    readRuleOutcome({
      resource: 'media',
      association: 'user-profile',
      viewer: 'own-admin',
      privacyEvidence: 'clear',
      viewerAuthorities,
      viewerIsOwner: false,
    });

  it('marks exactly the user-profile media cell for own-admin', () => {
    expect(READ_RULE_AUTHORITIES).toEqual(['user-management']);
    expect(READ_RULE_REQUIRED_AUTHORITIES).toEqual({
      media: { 'user-profile': { 'own-admin': 'user-management' } },
    });
  });

  it('only references cells and viewers the table actually defines', () => {
    for (const [resource, byAssociation] of Object.entries(
      READ_RULE_REQUIRED_AUTHORITIES
    )) {
      const rows = READ_RULES[resource as keyof typeof READ_RULES] as Record<
        string,
        ReadRuleRow
      >;
      for (const [association, byViewer] of Object.entries(byAssociation)) {
        const row = rows[association];
        expect(row, `${resource}/${association}`).toBeDefined();
        for (const [viewer, authority] of Object.entries(byViewer)) {
          expect(
            (READ_RULE_VIEWERS as readonly string[]).includes(viewer),
            `${resource}/${association}/${viewer}`
          ).toBe(true);
          expect(
            (READ_RULE_AUTHORITIES as readonly string[]).includes(
              authority as string
            ),
            `${resource}/${association}/${viewer}=${authority}`
          ).toBe(true);
          expect(row[viewer as keyof ReadRuleRow]).toBe('visible');
        }
      }
    }
  });

  it('never returns visible for an own-admin without user-management authority', () => {
    // §6.7: the spec cell is "visible (admin with user-management
    // authority)" — a same-community admin holding no authorities (or a
    // caller that passes none) must read hidden, never visible.
    expect(profileMedia()).toBe('hidden');
    expect(profileMedia([])).toBe('hidden');
    expect(profileMedia(['community-settings'])).toBe('hidden');
    expect(profileMedia(['user-management', 'community-settings'])).toBe(
      'visible'
    );
  });

  it('returns the cell outcome for an own-admin holding the authority', () => {
    expect(profileMedia(['user-management'])).toBe('visible');
  });

  it('lets the #162 override win over the authority qualifier', () => {
    expect(
      readRuleOutcome({
        resource: 'media',
        association: 'user-profile',
        viewer: 'own-admin',
        privacyEvidence: 'restricted',
        viewerAuthorities: ['user-management'],
        viewerIsOwner: false,
      })
    ).toBe('hidden');
  });

  it('pins the whole user-profile media row literally (every viewer column)', () => {
    // §6.4a/§6.7: only the authority-gated own-admin cell is visible.
    // Every other column — the own-community viewer/member/editor cells
    // that decide whether a NON-owner community member reads someone's
    // profile photo — is hidden, and flipping any of them to visible
    // must fail this literal row pin, not just the gated-cell tests
    // above. The account owner is the separate REQUIRED viewerIsOwner
    // input (see the owner-grant block below), not a column.
    expect(READ_RULES.media['user-profile']).toEqual({
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'hidden',
      'own-admin': 'visible',
    });
  });
});

describe('§6.4a read-rules table (#190): §6.7 owner grant', () => {
  const userProfileMedia = (
    viewer: (typeof READ_RULE_VIEWERS)[number],
    viewerIsOwner: boolean
  ) =>
    readRuleOutcome({
      resource: 'media',
      association: 'user-profile',
      viewer,
      privacyEvidence: 'clear',
      viewerIsOwner,
    });

  it('grants exactly the user-profile media row to the record owner', () => {
    expect(READ_RULE_OWNER_GRANTS).toEqual({ media: ['user-profile'] });
  });

  it('reads user-profile media as the account owner on every viewer column', () => {
    // §6.7: the owner holds no authority and may sit in any role column
    // (own-viewer through own-admin, or the super-admin column for the
    // null-community profile-photo exception); the per-record owner
    // flag — never the column — carries the grant.
    for (const viewer of READ_RULE_VIEWERS) {
      const ownerCapable =
        viewer !== 'anonymous-public' && viewer !== 'other-community';
      expect(userProfileMedia(viewer, true)).toBe(
        ownerCapable ? 'visible' : 'hidden'
      );
    }
  });

  it('never grants the owner flag to anonymous, other-community, unknown or non-boolean input', () => {
    for (const viewer of [
      'anonymous-public',
      'other-community',
      'unknown',
      '',
    ]) {
      expect(
        readRuleOutcome({
          resource: 'media',
          association: 'user-profile',
          viewer: viewer as never,
          privacyEvidence: 'clear',
          viewerIsOwner: true,
        })
      ).toBe('hidden');
    }
    for (const flag of [1, 'true', {}, null, undefined]) {
      expect(
        readRuleOutcome({
          resource: 'media',
          association: 'user-profile',
          viewer: 'own-viewer',
          privacyEvidence: 'clear',
          viewerIsOwner: flag as never,
        })
      ).toBe('hidden');
    }
  });

  it('keeps user-profile media hidden for a non-owner on every viewer column', () => {
    // The other side of §6.7: without the owner relationship the row is
    // hidden on every column — this helper passes no authorities, so
    // even own-admin reads hidden; its authority-gated visible cell is
    // pinned in the §6.7 authority-qualifier block above.
    for (const viewer of READ_RULE_VIEWERS) {
      expect(userProfileMedia(viewer, false)).toBe('hidden');
    }
  });

  it('never lets the owner flag widen any other row', () => {
    for (const [label, row] of allRows) {
      if (label === 'media/user-profile') continue;
      const [resource, association] = label.split('/');
      for (const viewer of Object.keys(row)) {
        const ordinary = readRuleOutcome({
          resource,
          association,
          viewer,
          privacyEvidence: 'clear',
          viewerIsOwner: false,
        });
        expect(
          readRuleOutcome({
            resource,
            association,
            viewer,
            privacyEvidence: 'clear',
            viewerIsOwner: true,
          }),
          `${label}/${viewer}`
        ).toBe(ordinary);
      }
    }
  });

  it('lets the #162 override win over the owner grant', () => {
    // Same fail-closed ordering as the authority qualifier: a
    // restricted or unevidenced row stays hidden even for its owner.
    for (const evidence of ['restricted', 'unevidenced'] as const) {
      expect(
        readRuleOutcome({
          resource: 'media',
          association: 'user-profile',
          viewer: 'own-viewer',
          privacyEvidence: evidence,
          viewerIsOwner: true,
        })
      ).toBe('hidden');
    }
  });

  it('fails closed when an untyped caller omits the owner flag', () => {
    // The input is REQUIRED at the type level; a caller that drops it
    // (this needs a cast) must not inherit the grant — a missing flag
    // is falsy, so the ordinary cell decides.
    expect(
      readRuleOutcome({
        resource: 'media',
        association: 'user-profile',
        viewer: 'own-viewer',
        privacyEvidence: 'clear',
      } as ReadRuleInput)
    ).toBe('hidden');
  });
});

describe('§6.4a read-rules table (#190): #139 matrix agreement', () => {
  it('restates exactly the §6.2 story audience grants for own-community roles', () => {
    for (const audience of STORY_AUDIENCES) {
      const row = READ_RULES.story[`audience-${audience}`];
      for (const [viewer, role] of Object.entries(ownViewerRole)) {
        expect(
          row[viewer as keyof typeof row] !== 'hidden',
          `${audience}/${viewer}`
        ).toBe(STORY_AUDIENCE_ROLES[audience].includes(role));
      }
    }
  });

  it('keeps community/editors stories off every public-terms column', () => {
    const publicTerms = [
      'anonymous-public',
      'other-community',
      'super-admin',
    ] as const;
    for (const audience of ['community', 'editors'] as const) {
      const row = READ_RULES.story[`audience-${audience}`];
      for (const viewer of publicTerms) {
        expect(row[viewer], `${audience}/${viewer}`).toBe('hidden');
      }
    }
    for (const viewer of publicTerms) {
      expect(READ_RULES.story['audience-public'][viewer]).toBe('visible');
    }
  });

  it('covers every community role except super_admin with an own- column', () => {
    expect(Object.values(ownViewerRole).sort()).toEqual(
      V2_COMMUNITY_ROLES.filter((role) => role !== 'super_admin').sort()
    );
  });

  it('gives the super-admin column exactly the anonymous column (public terms)', () => {
    for (const [label, row] of allRows) {
      expect(row['super-admin'], label).toBe(row['anonymous-public']);
    }
  });

  it('mirrors media rows onto their owning story and place/speaker rows', () => {
    for (const audience of STORY_READ_ASSOCIATIONS) {
      const mediaKey = audience.replace('audience', 'story-media');
      expect(READ_RULES.media[mediaKey as `story-media-${string}`]).toEqual(
        READ_RULES.story[audience]
      );
    }
    for (const association of ASSOCIATED_READ_ASSOCIATIONS) {
      const mediaKey = `place-speaker-media-${association}`;
      expect(
        READ_RULES.media[mediaKey as `place-speaker-media-${string}`]
      ).toEqual(READ_RULES.place[association]);
      expect(READ_RULES.speaker[association], `speaker/${association}`).toEqual(
        READ_RULES.place[association]
      );
    }
  });

  it('encodes the 2026-11-11 maintainer decision for place/speaker rows', () => {
    const readers = [
      'anonymous-public',
      'other-community',
      'super-admin',
      'own-viewer',
      'own-member',
    ] as const;
    for (const association of ASSOCIATED_READ_ASSOCIATIONS) {
      for (const resource of ['place', 'speaker'] as const) {
        const row = READ_RULES[resource][association];
        // Editors and admins see everything in their own community.
        expect(row['own-editor'], `${resource}/${association}`).toBe('visible');
        expect(row['own-admin'], `${resource}/${association}`).toBe('visible');
        // Everyone else sees a place/speaker only through a story they can
        // already read — story-less and unreadable-only rows stay hidden,
        // and even the readable-story cell never detaches from those
        // stories.
        for (const viewer of readers) {
          const outcome: ReadRuleOutcome = row[viewer];
          expect(
            association === 'via-readable-story'
              ? outcome === 'with-readable-stories'
              : outcome === 'hidden',
            `${resource}/${association}/${viewer}`
          ).toBe(true);
        }
      }
    }
  });
});
