/**
 * Machine-readable copy of the SPEC-V2 §6.4a role × resource × association
 * read table (#190). Pure data plus one fail-closed lookup helper: importing
 * it changes no behaviour anywhere. Tests and the Hono persona QA fixture
 * derive their expectations from it so the spec table, this const and the
 * served behaviour cannot drift apart.
 *
 * Scope notes that the spec states once and this module mirrors:
 *
 * - The #162 override (option A) applies over EVERY cell: a row with
 *   `isRestricted = true` or an unknown/unevidenced privacy value is hidden
 *   for every viewer — own-community editors, community admins and super
 *   admins included — on every read surface, and Explore is a public
 *   surface. `READ_RULE_OVERRIDES` states it; `readRuleOutcome` applies it.
 * - Community gates (§4/§6.1) are NOT modeled per cell: the anonymous,
 *   other-community and super-admin columns additionally require an active
 *   public community; own-community columns require an active community and
 *   hold in private communities; a disabled community hides every row from
 *   every role (export excepted).
 * - Story rows restate the §6.2/§6.3 story audiences that
 *   `STORY_AUDIENCE_ROLES` (sovereignty-policy) already encodes;
 *   tests/unit/read-rules.test.ts asserts the two never diverge.
 * - §6.7 authority qualifiers are layered over the cells instead of
 *   widening them: `READ_RULE_REQUIRED_AUTHORITIES` marks the cells
 *   whose outcome needs a named authority — the user-profile media cell
 *   is visible to an admin only WITH user-management authority — and
 *   `readRuleOutcome` resolves such a cell to `hidden` for a viewer
 *   that does not hold the authority.
 * - §6.7 owner grants are expressed the same way, as data over the
 *   cells: `READ_RULE_OWNER_GRANTS` names the rows whose read audience
 *   includes the record's owner (the account owner of a user-profile
 *   media row), and the REQUIRED `viewerIsOwner` input of
 *   `readRuleOutcome` carries that per-record relationship. The owner
 *   is not a viewer column; the flag resolves exactly those rows to
 *   `visible` for its owner (in an own-* or super-admin column only) and
 *   is ignored on every other row.
 */

export const READ_RULE_VIEWERS = [
  /** Anonymous caller on any public surface (Explore included). */
  'anonymous-public',
  /** Authenticated user of another community (public terms). */
  'other-community',
  /** super_admin: no community; public projections on anonymous terms. */
  'super-admin',
  'own-viewer',
  'own-member',
  'own-editor',
  'own-admin',
] as const;

export type ReadRuleViewer = (typeof READ_RULE_VIEWERS)[number];

export const READ_RULE_RESOURCES = [
  'story',
  'place',
  'speaker',
  'media',
] as const;

export type ReadRuleResource = (typeof READ_RULE_RESOURCES)[number];

/**
 * `visible` — readable on its own. `with-readable-stories` — readable only
 * through the stories this viewer can already read, never detached from
 * them. `hidden` — absent from every read surface; no existence signal.
 */
export const READ_RULE_OUTCOMES = [
  'visible',
  'with-readable-stories',
  'hidden',
] as const;

export type ReadRuleOutcome = (typeof READ_RULE_OUTCOMES)[number];

/** Story rows are keyed by the story's own audience (§6.3). */
export const STORY_READ_ASSOCIATIONS = [
  'audience-public',
  'audience-community',
  'audience-editors',
] as const;

export type StoryReadAssociation = (typeof STORY_READ_ASSOCIATIONS)[number];

/** Place/speaker rows are keyed by the viewer's story association (§6.4a). */
export const ASSOCIATED_READ_ASSOCIATIONS = [
  'via-readable-story',
  'story-less',
  'via-unreadable-stories-only',
] as const;

export type AssociatedReadAssociation =
  (typeof ASSOCIATED_READ_ASSOCIATIONS)[number];

/**
 * Media rows are keyed by the owning relation (§6.4a/§6.7). The story and
 * place/speaker media rows resolve the spec's "same cells as the owning
 * row" rows to their referents, so the table stays total and testable.
 */
export const MEDIA_READ_ASSOCIATIONS = [
  'story-media-public',
  'story-media-community',
  'story-media-editors',
  'place-speaker-media-via-readable-story',
  'place-speaker-media-story-less',
  'place-speaker-media-via-unreadable-stories-only',
  'user-profile',
  'community-branding',
  'unattached-staging',
] as const;

export type MediaReadAssociation = (typeof MEDIA_READ_ASSOCIATIONS)[number];

export interface ReadRuleTable {
  story: Record<StoryReadAssociation, ReadRuleRow>;
  place: Record<AssociatedReadAssociation, ReadRuleRow>;
  speaker: Record<AssociatedReadAssociation, ReadRuleRow>;
  media: Record<MediaReadAssociation, ReadRuleRow>;
}

export type ReadRuleRow = Record<ReadRuleViewer, ReadRuleOutcome>;

/**
 * The §6.4a table. Every cell is defined; TypeScript's `Record` types make
 * missing cells a compile error and tests/unit/read-rules.test.ts checks
 * totality and the §6.2/#139/#162 invariants at runtime.
 */
export const READ_RULES: ReadRuleTable = {
  story: {
    'audience-public': {
      'anonymous-public': 'visible',
      'other-community': 'visible',
      'super-admin': 'visible',
      'own-viewer': 'visible',
      'own-member': 'visible',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'audience-community': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'visible',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'audience-editors': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
  },
  place: {
    'via-readable-story': {
      'anonymous-public': 'with-readable-stories',
      'other-community': 'with-readable-stories',
      'super-admin': 'with-readable-stories',
      'own-viewer': 'with-readable-stories',
      'own-member': 'with-readable-stories',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'story-less': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'via-unreadable-stories-only': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
  },
  speaker: {
    'via-readable-story': {
      'anonymous-public': 'with-readable-stories',
      'other-community': 'with-readable-stories',
      'super-admin': 'with-readable-stories',
      'own-viewer': 'with-readable-stories',
      'own-member': 'with-readable-stories',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'story-less': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'via-unreadable-stories-only': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
  },
  media: {
    // Media of a story: same cells as that story's audience row.
    'story-media-public': {
      'anonymous-public': 'visible',
      'other-community': 'visible',
      'super-admin': 'visible',
      'own-viewer': 'visible',
      'own-member': 'visible',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'story-media-community': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'visible',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'story-media-editors': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    // Media of a place/speaker: same cells as the owning row.
    'place-speaker-media-via-readable-story': {
      'anonymous-public': 'with-readable-stories',
      'other-community': 'with-readable-stories',
      'super-admin': 'with-readable-stories',
      'own-viewer': 'with-readable-stories',
      'own-member': 'with-readable-stories',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'place-speaker-media-story-less': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'place-speaker-media-via-unreadable-stories-only': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    // §6.7: the account owner reads this row through the REQUIRED
    // viewerIsOwner input (READ_RULE_OWNER_GRANTS) — a per-record
    // relationship, not a viewer column — and an own-admin needs
    // user-management authority on top of the role:
    // READ_RULE_REQUIRED_AUTHORITIES gates that cell in readRuleOutcome.
    // The authorized uploader of an unattached-staging row stays a
    // route-level §6.7 check outside this table.
    'user-profile': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'hidden',
      'own-admin': 'visible',
    },
    'community-branding': {
      'anonymous-public': 'visible',
      'other-community': 'visible',
      'super-admin': 'visible',
      'own-viewer': 'visible',
      'own-member': 'visible',
      'own-editor': 'visible',
      'own-admin': 'visible',
    },
    'unattached-staging': {
      'anonymous-public': 'hidden',
      'other-community': 'hidden',
      'super-admin': 'hidden',
      'own-viewer': 'hidden',
      'own-member': 'hidden',
      'own-editor': 'hidden',
      'own-admin': 'visible',
    },
  },
};

/**
 * §6.7 authorities a cell may require. The spec's user-profile media
 * cell reads `visible (admin with user-management authority)`: the
 * table cell names who would read it, the authority names the grant
 * that must accompany the role.
 */
export const READ_RULE_AUTHORITIES = ['user-management'] as const;

export type ReadRuleAuthority = (typeof READ_RULE_AUTHORITIES)[number];

/**
 * Cells whose outcome applies only when the viewer holds the named
 * authority (§6.7). `readRuleOutcome` resolves them to `hidden` for a
 * viewer without the authority — including a caller that passes no
 * authorities — so the user-profile cell can never widen to every
 * same-community admin. The account-owner half of that row's §6.7
 * audience is the separate `viewerIsOwner` input below and needs no
 * authority.
 */
export const READ_RULE_REQUIRED_AUTHORITIES = {
  media: {
    'user-profile': { 'own-admin': 'user-management' },
  },
} as const satisfies Partial<{
  [resource in ReadRuleResource]: Partial<{
    [association: string]: Partial<Record<ReadRuleViewer, ReadRuleAuthority>>;
  }>;
}>;

/**
 * §6.7 rows whose read audience includes the record's owner: the
 * account owner of a user-profile media row reads it. The grant is a
 * per-record relationship the caller resolves from the session — an
 * anonymous caller is never the owner — carried by the REQUIRED
 * `viewerIsOwner` input of `readRuleOutcome`, never a viewer column.
 * `readRuleOutcome` resolves exactly these rows to `visible` for the
 * owner (own-* or super-admin column only) and ignores the flag on every
 * other row; it widens only the granted rows, and only for their owner.
 */
export const READ_RULE_OWNER_GRANTS = {
  media: ['user-profile'],
} as const satisfies Partial<{
  [resource in ReadRuleResource]: readonly string[];
}>;

/**
 * The #162 evidence for one row, a REQUIRED input to `readRuleOutcome`:
 *
 * - `restricted` — the row's `isRestricted` flag is true;
 * - `unevidenced` — the row's privacy value is unknown/unevidenced:
 *   missing, `''`, `'unknown'`, or any value the canonical audiences do
 *   not name;
 * - `clear` — unrestricted with a known privacy value; a place/speaker
 *   has no privacy field of its own (§6.4), so an unrestricted one is
 *   `clear`.
 */
export const READ_RULE_PRIVACY_EVIDENCE = [
  'clear',
  'restricted',
  'unevidenced',
] as const;

export type ReadRulePrivacyEvidence =
  (typeof READ_RULE_PRIVACY_EVIDENCE)[number];

/**
 * The #162 override (option A), stated once for every cell of the table: a
 * restricted or unknown/unevidenced-privacy row is hidden for EVERY viewer —
 * including own-community admins and super admins — on every read surface.
 * Explore is a public surface; no session or privilege widens it.
 * `readRuleOutcome` takes the evidence as a REQUIRED input and applies this
 * override to every value except `clear`, so a missing or unrecognized
 * evidence value fails closed to hidden instead of falling through to the
 * cell.
 */
export const READ_RULE_OVERRIDES = {
  restrictedOrUnevidencedPrivacy: {
    ruling: '#162 (option A)',
    outcome: 'hidden' as const,
    /** Every viewer of the table, editors/admins/super admins included. */
    viewers: READ_RULE_VIEWERS,
    note: 'Explore is a public surface; a session never widens it.',
  },
} as const;

export interface ReadRuleInput {
  resource: string;
  association: string;
  viewer: string;
  /**
   * REQUIRED #162 evidence for the row (its `isRestricted` flag and
   * privacy value). Not optional: unknown or missing values fail closed
   * to hidden for every viewer inside `readRuleOutcome`.
   */
  privacyEvidence: ReadRulePrivacyEvidence;
  /**
   * Authorities the viewer holds (§6.7). A cell that requires an
   * authority resolves to `hidden` unless this list carries it; omitted
   * means none. Fail closed.
   */
  viewerAuthorities?: readonly string[];
  /**
   * REQUIRED per-record §6.7 ownership: the viewer is the owner of this
   * specific row (today: the account owner a user-profile media row
   * attaches to). The caller resolves the relationship from the
   * session — an anonymous caller is never the owner. It resolves
   * exactly the `READ_RULE_OWNER_GRANTS` rows to `visible` and is
   * ignored on every other row. Only a strict `true` together with an
   * owner-capable viewer column (own-* or super-admin) counts; anything
   * else fails closed to the ordinary cell.
   */
  viewerIsOwner: boolean;
}

/**
 * Resolve one §6.4a cell (plus the #162 override, the §6.7 owner grant
 * and the §6.7 authority qualifiers). Unknown resources, associations
 * or viewers fail closed to `hidden`; community gates (§4/§6.1) remain
 * the caller's separate precondition.
 */
// Owner-capable columns: own-community accounts, plus super-admin for the
// null-community profile-photo exception (§6.7). Never anonymous or
// other-community.
const OWNER_VIEWERS: ReadonlySet<string> = new Set([
  'super-admin',
  'own-viewer',
  'own-member',
  'own-editor',
  'own-admin',
]);

export function readRuleOutcome(input: ReadRuleInput): ReadRuleOutcome {
  // #162 first, over every cell: the guard is `!== 'clear'`, not
  // `=== 'restricted'`, so restricted rows, unevidenced rows AND any
  // missing/unknown evidence value an untyped caller passes all fail
  // closed to hidden for every viewer.
  if (input.privacyEvidence !== 'clear') {
    return READ_RULE_OVERRIDES.restrictedOrUnevidencedPrivacy.outcome;
  }
  // §6.7 owner grant second: a restricted or unevidenced row stays
  // hidden even for its owner (#162 wins, fail closed), and the owner
  // of a granted row needs no authority — exactly the
  // READ_RULE_OWNER_GRANTS rows resolve to `visible`, never any other
  // row; it widens only those rows, and only for their owner.
  // The grant needs a strict boolean true AND an owner-capable viewer
  // column, so an anonymous, other-community or unknown viewer never
  // receives it (fail closed).
  if (
    input.viewerIsOwner === true &&
    OWNER_VIEWERS.has(input.viewer) &&
    isOwnerGranted(input.resource, input.association)
  ) {
    return 'visible';
  }
  const authority = lookupRequiredAuthority(
    input.resource,
    input.association,
    input.viewer
  );
  if (authority && !(input.viewerAuthorities ?? []).includes(authority)) {
    return 'hidden';
  }
  const rows = lookupRows(input.resource);
  const row = rows ? lookupRow(rows, input.association) : undefined;
  if (!row) return 'hidden';
  const outcome = lookupOutcome(row, input.viewer);
  return outcome ?? 'hidden';
}

function isOwnerGranted(resource: string, association: string): boolean {
  const byResource = READ_RULE_OWNER_GRANTS as Record<
    string,
    readonly string[] | undefined
  >;
  return (byResource[resource] ?? []).includes(association);
}

function lookupRequiredAuthority(
  resource: string,
  association: string,
  viewer: string
): ReadRuleAuthority | undefined {
  const byResource = READ_RULE_REQUIRED_AUTHORITIES as Record<
    string,
    Record<string, Record<string, ReadRuleAuthority>> | undefined
  >;
  return byResource[resource]?.[association]?.[viewer];
}

function lookupRows(
  resource: string
): Record<string, Record<string, ReadRuleOutcome>> | undefined {
  if (!(READ_RULE_RESOURCES as readonly string[]).includes(resource)) {
    return undefined;
  }
  return READ_RULES[resource as ReadRuleResource] as Record<
    string,
    Record<string, ReadRuleOutcome>
  >;
}

function lookupRow(
  rows: Record<string, Record<string, ReadRuleOutcome>>,
  association: string
): Record<string, ReadRuleOutcome> | undefined {
  return rows[association];
}

function lookupOutcome(
  row: Record<string, ReadRuleOutcome>,
  viewer: string
): ReadRuleOutcome | undefined {
  const outcome = row[viewer];
  return (READ_RULE_OUTCOMES as readonly string[]).includes(outcome)
    ? outcome
    : undefined;
}
