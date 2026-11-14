import { describe, expect, it } from 'vitest';
import {
  ASSOCIATED_READ_ASSOCIATIONS,
  MEDIA_READ_ASSOCIATIONS,
  READ_RULE_OVERRIDES,
  READ_RULE_OUTCOMES,
  READ_RULE_RESOURCES,
  READ_RULES,
  READ_RULE_VIEWERS,
  STORY_READ_ASSOCIATIONS,
  readRuleOutcome,
  type ReadRuleOutcome,
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
      })
    ).toBe('with-readable-stories');
    expect(
      readRuleOutcome({
        resource: 'theme',
        association: 'via-readable-story',
        viewer: 'anonymous-public',
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-any-story',
        viewer: 'anonymous-public',
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-readable-story',
        viewer: 'elder',
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'via-readable-story',
        viewer: '',
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
    for (const [label, row] of allRows) {
      for (const viewer of Object.keys(row)) {
        expect(
          readRuleOutcome({
            resource: label.split('/')[0],
            association: label.split('/')[1],
            viewer,
            restrictedOrUnevidenced: true,
          }),
          `${label}/${viewer}`
        ).toBe('hidden');
      }
    }
    // The highest privileges never escape the override (#162 option A).
    expect(
      readRuleOutcome({
        resource: 'story',
        association: 'audience-public',
        viewer: 'own-admin',
        restrictedOrUnevidenced: true,
      })
    ).toBe('hidden');
    expect(
      readRuleOutcome({
        resource: 'place',
        association: 'story-less',
        viewer: 'super-admin',
        restrictedOrUnevidenced: true,
      })
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
