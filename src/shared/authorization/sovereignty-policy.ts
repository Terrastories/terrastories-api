export const V2_COMMUNITY_ROLES = [
  'viewer',
  'member',
  'editor',
  'admin',
  'super_admin',
] as const;

export type V2CommunityRole = (typeof V2_COMMUNITY_ROLES)[number];

export function isV2CommunityRole(role: string): role is V2CommunityRole {
  return (V2_COMMUNITY_ROLES as readonly string[]).includes(role);
}

/**
 * Canonical story audiences (SPEC-V2 §6.3). These are read audiences for
 * story content, distinct from `FieldVisibilityCategory`, which classifies
 * individual fields inside an already-authorized response.
 */
export const STORY_AUDIENCES = ['public', 'community', 'editors'] as const;

export type StoryAudience = (typeof STORY_AUDIENCES)[number];

/**
 * Which authenticated roles may read each story audience inside their own
 * ACTIVE community (SPEC-V2 §6.2): viewer adds `public`, `member` adds
 * `community`, `editor`/`admin` add `editors`. A private community does not
 * block these reads; only community `status` does. `super_admin` never
 * appears: it has no authenticated community-content access, only public
 * projections on anonymous terms.
 */
export const STORY_AUDIENCE_ROLES: Record<
  StoryAudience,
  readonly V2CommunityRole[]
> = {
  public: ['viewer', 'member', 'editor', 'admin'],
  community: ['member', 'editor', 'admin'],
  editors: ['editor', 'admin'],
};

export function roleCanReadStoryAudience(
  role: V2CommunityRole,
  audience: StoryAudience
): boolean {
  return STORY_AUDIENCE_ROLES[audience].includes(role);
}

/**
 * Runtime read access for a story row on the transitional Fastify schema.
 * `unavailable` is not a canonical audience (SPEC-V2 §6.3): it is the
 * fail-closed runtime treatment of rows the Fastify columns cannot map to a
 * canonical audience — restricted rows and unknown privacy levels. Such rows
 * are unreadable by EVERY role (admin, editor, member, viewer, super_admin,
 * and the legacy `elder` role) until the community approves an explicit
 * disposition (canonical audience or archive-only).
 */
export type TransitionalStoryReadAccess = StoryAudience | 'unavailable';

export function roleCanReadStoryAccess(
  role: V2CommunityRole,
  access: TransitionalStoryReadAccess
): boolean {
  if (access === 'unavailable') {
    return false;
  }
  return roleCanReadStoryAudience(role, access);
}

/**
 * Every runtime read access a role may hold, used to build list/count
 * filters (SPEC-V2 §6.2/§6.3). Never contains `unavailable`: that access is
 * readable by no role. On the current Fastify schema `editors` matches no
 * row (unknown privacy levels are unavailable), but the canonical grant
 * stays so migration can select it explicitly. `super_admin` holds none: it
 * has no authenticated community-content access.
 */
export function storyAccessForRole(
  role: V2CommunityRole
): readonly TransitionalStoryReadAccess[] {
  switch (role) {
    case 'admin':
      return ['public', 'community', 'editors'];
    case 'editor':
      return ['public', 'community', 'editors'];
    case 'member':
      return ['public', 'community'];
    case 'viewer':
      return ['public'];
    case 'super_admin':
      return [];
  }
}

/**
 * Transitional mapping from the Fastify V1 story columns to runtime read
 * access (SPEC-V2 §6.3). The physical columns stay until #145/#146; this
 * function is the single documented mapping and its SQL transcription in
 * `storyAudienceCondition` (story repository) must stay in sync:
 *
 * - `privacyLevel = 'public'` + unrestricted -> `public`.
 * - `privacyLevel = 'members_only'` + unrestricted -> `community`.
 * - `isRestricted = true` -> `unavailable`. V1 limited these rows to
 *   elder/admin audiences with no exact canonical equivalent (§6.3), so they
 *   stay unavailable in V2 runtime to every role until a community-approved
 *   disposition; `editors` is the closest retained audience but is never
 *   selected implicitly.
 * - any other `privacyLevel` (e.g. `'restricted'`, `'private'`, `''`,
 *   unknown) + unrestricted -> `unavailable` via the same
 *   explicit-disposition path; never `editors`, never `public`.
 */
export function fastifyStoryToAudience(
  privacyLevel: string,
  isRestricted: boolean
): TransitionalStoryReadAccess {
  if (isRestricted) {
    return 'unavailable';
  }
  if (privacyLevel === 'public') {
    return 'public';
  }
  if (privacyLevel === 'members_only') {
    return 'community';
  }
  return 'unavailable';
}

export const CONTENT_ROUTE_FAMILIES = [
  'stories',
  'places',
  'speakers',
  'themes',
  'files',
  'nested-relations',
  'aggregates',
  'exports',
] as const;

export type ContentRouteFamily = (typeof CONTENT_ROUTE_FAMILIES)[number];

export const PROTECTED_SURFACES = [
  'crud',
  'list',
  'search',
  'stats',
  'public-api',
  'export',
  'file',
  'nested-relation',
  'aggregate',
  'error',
] as const;

export type ProtectedSurface = (typeof PROTECTED_SURFACES)[number];

export const FIELD_VISIBILITY_CATEGORIES = [
  'public',
  'community-only',
  'role-restricted',
  'never-exposed',
] as const;

export type FieldVisibilityCategory =
  (typeof FIELD_VISIBILITY_CATEGORIES)[number];

/**
 * Canonical community publication/lifecycle gates (SPEC-V2 §6.1).
 * `visibility` controls public discoverability; `status` is operational
 * lifecycle, not a privacy flag. A private or disabled community overrides
 * any story-level public visibility for anonymous callers (§4).
 */
export const COMMUNITY_VISIBILITIES = ['public', 'private'] as const;

export type CommunityVisibility = (typeof COMMUNITY_VISIBILITIES)[number];

export const COMMUNITY_STATUSES = ['active', 'disabled'] as const;

export type CommunityStatus = (typeof COMMUNITY_STATUSES)[number];

/**
 * Transitional mapping from the Fastify community columns to the canonical
 * gates (SPEC-V2 §6.1). The physical columns stay until #145/#146:
 * `communities.publicStories === true` ⇔ `visibility: 'public'`, and
 * `communities.isActive === true` ⇔ `status: 'active'`.
 */
export function fastifyCommunityToGates(
  publicStories: boolean,
  isActive: boolean
): { visibility: CommunityVisibility; status: CommunityStatus } {
  return {
    visibility: publicStories ? 'public' : 'private',
    status: isActive ? 'active' : 'disabled',
  };
}

/**
 * Session viewer context for the unauthenticated community discovery
 * surfaces (`GET /api/communities`, `GET /api/v1/communities`,
 * `GET /api/v1/communities/:id`). Physical Fastify role/session shape.
 */
export interface CommunityDiscoveryViewer {
  communityId: number;
  role: string;
}

/**
 * SPEC-V2 §4/§6.1 community discoverability on the unauthenticated public/v1
 * community surfaces: a community is discoverable only while active, and
 * anonymous or other-community callers additionally require `visibility:
 * 'public'` (Fastify `publicStories = true`). A same-community session user
 * may also discover their own active-but-private community; `super_admin`
 * never widens discovery on these routes (it sees what anonymous sees —
 * management routes under `super_admin.ts` are a separate surface). Disabled
 * communities are undiscoverable for everyone. The SQL transcription of this
 * gate lives in `CommunityRepository.findDiscoverable` and must stay in sync.
 */
export function canDiscoverCommunity(
  gates: { visibility: CommunityVisibility; status: CommunityStatus },
  resourceCommunityId: number,
  viewer: CommunityDiscoveryViewer | null
): boolean {
  if (gates.status !== 'active') {
    return false;
  }
  if (gates.visibility === 'public') {
    return true;
  }
  return Boolean(
    viewer &&
      viewer.role !== 'super_admin' &&
      viewer.communityId === resourceCommunityId
  );
}

/**
 * Transitional mapping from a physical Fastify role to the canonical V2 role
 * the policy must reason with (SPEC-V2 §6.2). A Fastify `viewer` maps to V2
 * `member`, not `viewer`: the pinned Fastify V1 story reads for
 * non-`elder`/`admin` users filtered only on `isRestricted = false` and never
 * enforced `privacyLevel`, so a Fastify `viewer` effectively read
 * `members_only` stories — the audience V2 grants to `member`. Feeding the
 * physical `viewer` string into the policy would map it to V2 `viewer`
 * semantics (public only) and silently narrow that user's effective access,
 * which SPEC-V2 §4 forbids without an explicit product decision. The legacy
 * `elder` role and unknown values return null: callers keep the legacy V1
 * path for them (community-approved disposition pending, §6.2).
 */
export function fastifyRoleToV2Role(
  physicalRole: string
): V2CommunityRole | null {
  switch (physicalRole) {
    case 'viewer':
    case 'member':
      return 'member';
    case 'editor':
      return 'editor';
    case 'admin':
      return 'admin';
    case 'super_admin':
      return 'super_admin';
    default:
      return null;
  }
}

/**
 * Runtime story read accesses for a physical Fastify role, used to build
 * list/count filters. Canonical roles go through `fastifyRoleToV2Role`.
 * The legacy `elder` role has no canonical equivalent (§6.2); it keeps the
 * V2 `member` reach, so restricted rows and unknown privacy levels stay
 * unavailable to it as well (§6.3). Unknown roles hold no access (fail
 * closed).
 */
export function storyAccessForPhysicalRole(
  physicalRole: string
): readonly TransitionalStoryReadAccess[] {
  const v2Role = fastifyRoleToV2Role(physicalRole);
  if (v2Role) {
    return storyAccessForRole(v2Role);
  }
  return physicalRole === 'elder' ? storyAccessForRole('member') : [];
}

export interface AuthorizationActor {
  id: number;
  role: V2CommunityRole;
  /**
   * Canonical super admins never carry a communityId (§6.2); community
   * roles always do. Transitional Fastify super_admin rows may still hold
   * one, but they are denied before communityId is ever consulted.
   */
  communityId: number | null;
  active: boolean;
}

export type AuthorizationReason =
  | 'same-community'
  | 'explicit-public'
  | 'authentication-required'
  | 'not-explicitly-public'
  | 'cross-community-denied'
  | 'super-admin-content-denied'
  | 'inactive-community'
  | 'disabled-user'
  | 'never-exposed'
  | 'role-restricted';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: AuthorizationReason;
}

export interface CommunityContentAuthorizationInput {
  actor: AuthorizationActor | null;
  resourceCommunityId: number;
  family: ContentRouteFamily;
  surface: ProtectedSurface;
  visibility: FieldVisibilityCategory;
  /** Canonical community lifecycle gate (§6.1); `disabled` denies all content access. */
  communityStatus: CommunityStatus;
  /** Canonical community publication gate (§6.1); only `public` admits anonymous projections. */
  communityVisibility?: CommunityVisibility;
  allowedRoles?: readonly V2CommunityRole[];
}

export interface FieldExposureInput {
  category: FieldVisibilityCategory;
  actor: AuthorizationActor | null;
  actorCommunityId: number | null;
  resourceCommunityId: number | null;
  /** Publication gate for `public` fields: only a `public` community exposes them anonymously. */
  communityVisibility?: CommunityVisibility;
  allowedRoles?: readonly V2CommunityRole[];
}

export interface FieldVisibilityRule {
  category: FieldVisibilityCategory;
  allowedRoles?: readonly V2CommunityRole[];
}

export interface FieldProjectionContext {
  actor: AuthorizationActor | null;
  actorCommunityId: number | null;
  resourceCommunityId: number | null;
  communityVisibility?: CommunityVisibility;
}

export const AUTHORIZATION_MATRIX = {
  content: Object.fromEntries(
    CONTENT_ROUTE_FAMILIES.map((family) => [
      family,
      {
        communityScoped: true,
        superAdminContentAccess: false,
      },
    ])
  ) as Record<
    ContentRouteFamily,
    { communityScoped: true; superAdminContentAccess: false }
  >,
  surfaces: Object.fromEntries(
    PROTECTED_SURFACES.map((surface) => [
      surface,
      {
        mustPreserveCommunityIsolation: true,
      },
    ])
  ) as Record<ProtectedSurface, { mustPreserveCommunityIsolation: true }>,
  fields: {
    public: { anonymous: 'explicit-only' },
    'community-only': { anonymous: false },
    'role-restricted': { anonymous: false },
    'never-exposed': { anonymous: false },
  },
} as const;

export const NEVER_EXPOSED_FIELDS_BY_FAMILY: Record<
  ContentRouteFamily,
  readonly string[]
> = {
  stories: [],
  places: [],
  speakers: [],
  themes: ['mapboxAccessToken'],
  files: ['path'],
  'nested-relations': [],
  aggregates: [],
  exports: [],
};

export function authorizeCommunityContent(
  input: CommunityContentAuthorizationInput
): AuthorizationDecision {
  const {
    actor,
    resourceCommunityId,
    surface,
    visibility,
    communityStatus,
    communityVisibility = 'private',
    allowedRoles,
  } = input;

  if (communityStatus !== 'active') {
    return deny('inactive-community');
  }

  if (actor && actor.active !== true) {
    return deny('disabled-user');
  }

  if (visibility === 'never-exposed') {
    return deny('never-exposed');
  }

  if (actor?.role === 'super_admin') {
    return deny('super-admin-content-denied');
  }

  if (surface === 'public-api') {
    if (visibility === 'public' && communityVisibility === 'public') {
      return allow('explicit-public');
    }
    if (actor && actor.communityId !== resourceCommunityId) {
      return deny('cross-community-denied');
    }
    return deny('not-explicitly-public');
  }

  if (!actor) {
    return deny('authentication-required');
  }

  if (actor.communityId !== resourceCommunityId) {
    return deny('cross-community-denied');
  }

  if (
    visibility === 'role-restricted' &&
    (!allowedRoles || !allowedRoles.includes(actor.role))
  ) {
    return deny('role-restricted');
  }

  return allow('same-community');
}

export function canExposeField(input: FieldExposureInput): boolean {
  const {
    category,
    actor,
    actorCommunityId,
    resourceCommunityId,
    communityVisibility = 'private',
    allowedRoles,
  } = input;

  if (category === 'never-exposed') {
    return false;
  }

  if (actor?.role === 'super_admin') {
    return false;
  }

  if (category === 'public') {
    return communityVisibility === 'public';
  }

  if (!actor || actor.active !== true) {
    return false;
  }

  if (
    actorCommunityId === null ||
    actorCommunityId !== resourceCommunityId ||
    actor.communityId !== resourceCommunityId
  ) {
    return false;
  }

  if (category === 'role-restricted') {
    return Boolean(allowedRoles?.includes(actor.role));
  }

  return true;
}

export function projectVisibleFields<T extends Record<string, unknown>>(
  source: T,
  rules: Partial<Record<keyof T, FieldVisibilityRule>>,
  context: FieldProjectionContext
): Partial<T> {
  const projected: Partial<T> = {};

  for (const key of Object.keys(rules) as Array<keyof T>) {
    const rule = rules[key];
    if (!rule) continue;

    if (
      canExposeField({
        category: rule.category,
        actor: context.actor,
        actorCommunityId: context.actorCommunityId,
        resourceCommunityId: context.resourceCommunityId,
        communityVisibility: context.communityVisibility,
        allowedRoles: rule.allowedRoles,
      })
    ) {
      projected[key] = source[key];
    }
  }

  return projected;
}

export function projectCommunityResourceFields<
  T extends Record<string, unknown>,
>(
  family: ContentRouteFamily,
  source: T,
  actor: AuthorizationActor,
  resourceCommunityId: number | null
): Partial<T> {
  const neverExposed = new Set(NEVER_EXPOSED_FIELDS_BY_FAMILY[family]);
  const rules = Object.fromEntries(
    Object.keys(source).map((key) => [
      key,
      {
        category: neverExposed.has(key)
          ? ('never-exposed' as const)
          : ('community-only' as const),
      },
    ])
  ) as Partial<Record<keyof T, FieldVisibilityRule>>;

  return projectVisibleFields(source, rules, {
    actor,
    actorCommunityId: actor.communityId,
    resourceCommunityId,
  });
}

export interface AuthorizationAuditInput {
  actor: AuthorizationActor | null;
  resourceCommunityId: number;
  family: ContentRouteFamily;
  surface: ProtectedSurface;
  decision: AuthorizationDecision;
}

export function createAuthorizationAuditEvent(input: AuthorizationAuditInput) {
  return {
    action: 'authorization_decision' as const,
    actorId: input.actor?.id ?? null,
    actorRole: input.actor?.role ?? 'anonymous',
    actorCommunityId: input.actor?.communityId ?? null,
    resourceCommunityId: input.resourceCommunityId,
    family: input.family,
    surface: input.surface,
    allowed: input.decision.allowed,
    reason: input.decision.reason,
  };
}

function allow(reason: AuthorizationReason): AuthorizationDecision {
  return { allowed: true, reason };
}

function deny(reason: AuthorizationReason): AuthorizationDecision {
  return { allowed: false, reason };
}
