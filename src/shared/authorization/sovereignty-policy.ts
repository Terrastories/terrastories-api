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
 * Transitional mapping from the Fastify V1 story columns to canonical
 * audiences (SPEC-V2 §6.3). The physical columns stay until #145/#146;
 * this function is the single documented mapping and its SQL transcription
 * in `StoryRepository.findMany` must stay in sync:
 *
 * - `isRestricted = true` -> `editors`. The Fastify restriction was
 *   elder/admin-only, which has no canonical runtime equivalent; `editors`
 *   is the closest retained audience and the fail-closed default.
 * - `privacyLevel = 'public'` + unrestricted -> `public`.
 * - `privacyLevel = 'members_only'` + unrestricted -> `community`.
 * - any other `privacyLevel` -> `editors` (fail-closed for unknown legacy
 *   values; migration dispositions them explicitly per §6.3).
 */
export function fastifyStoryToAudience(
  privacyLevel: string,
  isRestricted: boolean
): StoryAudience {
  if (isRestricted) {
    return 'editors';
  }
  if (privacyLevel === 'public') {
    return 'public';
  }
  if (privacyLevel === 'members_only') {
    return 'community';
  }
  return 'editors';
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

export interface AuthorizationActor {
  id: number;
  role: V2CommunityRole;
  communityId: number;
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
  communityActive: boolean;
  explicitlyPublic?: boolean;
  allowedRoles?: readonly V2CommunityRole[];
}

export interface FieldExposureInput {
  category: FieldVisibilityCategory;
  actor: AuthorizationActor | null;
  actorCommunityId: number | null;
  resourceCommunityId: number;
  explicitlyPublic?: boolean;
  allowedRoles?: readonly V2CommunityRole[];
}

export interface FieldVisibilityRule {
  category: FieldVisibilityCategory;
  allowedRoles?: readonly V2CommunityRole[];
}

export interface FieldProjectionContext {
  actor: AuthorizationActor | null;
  actorCommunityId: number | null;
  resourceCommunityId: number;
  explicitlyPublic?: boolean;
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
    communityActive,
    explicitlyPublic = false,
    allowedRoles,
  } = input;

  if (!communityActive) {
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
    if (visibility === 'public' && explicitlyPublic) {
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
    explicitlyPublic = false,
    allowedRoles,
  } = input;

  if (category === 'never-exposed') {
    return false;
  }

  if (actor?.role === 'super_admin') {
    return false;
  }

  if (category === 'public') {
    return explicitlyPublic;
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
        explicitlyPublic: context.explicitlyPublic,
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
  resourceCommunityId: number
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
