export const V2_COMMUNITY_ROLES = [
  'viewer',
  'editor',
  'admin',
  'super_admin',
] as const;

export type V2CommunityRole = (typeof V2_COMMUNITY_ROLES)[number];

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
