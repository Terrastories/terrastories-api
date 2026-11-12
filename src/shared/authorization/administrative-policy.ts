/**
 * SPEC-V2 §7 administrative authority (Bootstrap and account lifecycle).
 *
 * Transport-independent decisions for the administrative sequences that can
 * otherwise mint protected access without touching a content route:
 *
 * - enrollment (creating an account in a community),
 * - membership/role changes on an existing account,
 * - publication changes (Fastify `communities.public_stories`).
 *
 * The spec rules these primitives encode:
 *
 * - "Community administrators authorize membership, community roles, member
 *   recovery, and publication."
 * - "System administrators may provision/manage system and community
 *   lifecycle records, but cannot unilaterally acquire protected access by
 *   issuing/resetting credentials, changing membership/roles, impersonating
 *   users, or changing publication."
 * - The first administrator of a hosted community is provisioned only for a
 *   community that has never had an administrator and holds no community
 *   content; issuance closes once any administrator exists.
 * - §9: login, authorized bootstrap/recovery and health are the only
 *   non-community-authenticated exceptions. There is no anonymous public
 *   signup path into a community.
 *
 * Every decision fails closed: unknown roles and anonymous callers are denied.
 */
import { fastifyRoleToV2Role } from './sovereignty-policy.js';

export type AdministrativeDecisionReason =
  | 'community-admin'
  | 'system-account'
  | 'unclaimed-empty-community'
  | 'lifecycle-fields-only'
  | 'no-publication-change'
  | 'anonymous'
  | 'not-community-admin'
  | 'cross-community'
  | 'system-privilege-is-not-community-authority'
  | 'system-role-not-assignable'
  | 'first-administrator-only'
  | 'community-claimed-or-holds-content'
  | 'reactivation-requires-community-authority'
  | 'stale-membership-decision'
  | 'last-active-administrator';

export interface AdministrativeDecision {
  allowed: boolean;
  reason: AdministrativeDecisionReason;
}

/** The caller as known from the authenticated session (physical role). */
export interface AdministrativeActor {
  id: number;
  role: string;
  communityId: number | null;
}

/**
 * Whether a community may still receive its first administrator through a
 * system lifecycle action: it has no community account (any role other than
 * a system `super_admin` row, any status) and no community content.
 */
export interface CommunityClaimState {
  hasCommunityAccounts: boolean;
  hasContent: boolean;
}

function allow(reason: AdministrativeDecisionReason): AdministrativeDecision {
  return { allowed: true, reason };
}

function deny(reason: AdministrativeDecisionReason): AdministrativeDecision {
  return { allowed: false, reason };
}

/**
 * Enrollment into a community (`POST /api/v1/auth/register`). Only a
 * same-community administrator may create an account; system privilege
 * never assigns community membership through this path and nobody mints a
 * `super_admin` account through it.
 */
export function authorizeCommunityEnrollment(input: {
  actor: AdministrativeActor | null;
  targetCommunityId: number;
  requestedRole: string;
}): AdministrativeDecision {
  if (!input.actor) {
    return deny('anonymous');
  }
  if (input.requestedRole === 'super_admin') {
    return deny('system-role-not-assignable');
  }
  const actorRole = fastifyRoleToV2Role(input.actor.role);
  if (actorRole === 'super_admin') {
    return deny('system-privilege-is-not-community-authority');
  }
  if (actorRole !== 'admin') {
    return deny('not-community-admin');
  }
  if (input.actor.communityId !== input.targetCommunityId) {
    return deny('cross-community');
  }
  return allow('community-admin');
}

/**
 * Membership or role change by a community administrator
 * (`PUT`/`PATCH /api/v1/users/:id`, including activation status). Only a
 * same-community administrator decides, and nobody assigns `super_admin`
 * through a community path.
 */
export function authorizeCommunityMembershipChange(input: {
  actor: AdministrativeActor | null;
  targetCommunityId: number;
  requestedRole?: string;
}): AdministrativeDecision {
  return authorizeCommunityEnrollment({
    actor: input.actor,
    targetCommunityId: input.targetCommunityId,
    requestedRole: input.requestedRole ?? 'viewer',
  });
}

/**
 * System account creation (`POST /api/v1/super_admin/users`). A system
 * administrator may create system (`super_admin`) accounts, and may
 * provision only the first administrator of a community that has never had
 * a community account and holds no content. Any other community account is
 * membership, which needs community authority.
 */
export function authorizeSystemAccountProvisioning(input: {
  requestedRole: string;
  community: CommunityClaimState;
}): AdministrativeDecision {
  if (input.requestedRole === 'super_admin') {
    return allow('system-account');
  }
  if (input.requestedRole !== 'admin') {
    return deny('first-administrator-only');
  }
  if (input.community.hasCommunityAccounts || input.community.hasContent) {
    return deny('community-claimed-or-holds-content');
  }
  return allow('unclaimed-empty-community');
}

/**
 * System account update (`PUT /api/v1/super_admin/users/:id`). Profile
 * fields and deactivation stay available. A role or community change is a
 * membership/role change and needs community authority, except moving a
 * system account between system records. Reactivating a deactivated
 * community account re-admits a member the community may have revoked, so
 * it needs community authority too; system accounts may be reactivated.
 */
export function authorizeSystemAccountUpdate(input: {
  current: { role: string; communityId: number | null; isActive?: boolean };
  requested: { role?: string; communityId?: number; isActive?: boolean };
}): AdministrativeDecision {
  if (
    input.current.role !== 'super_admin' &&
    input.current.isActive !== true &&
    input.requested.isActive === true
  ) {
    return deny('reactivation-requires-community-authority');
  }
  const nextRole = input.requested.role ?? input.current.role;
  const nextCommunityId =
    input.requested.communityId ?? input.current.communityId;
  const roleChanges = nextRole !== input.current.role;
  const communityChanges = nextCommunityId !== input.current.communityId;

  if (!roleChanges && !communityChanges) {
    return allow('lifecycle-fields-only');
  }
  if (input.current.role === 'super_admin' && nextRole === 'super_admin') {
    return allow('system-account');
  }
  return deny('system-privilege-is-not-community-authority');
}

/**
 * Publication change (`communities.public_stories`). Only a same-community
 * administrator authorizes publication; a system administrator may not
 * change it. Re-sending the current value is not a change.
 */
export function authorizePublicationChange(input: {
  actor: AdministrativeActor | null;
  communityId: number;
  currentPublic: boolean;
  requestedPublic: boolean | undefined;
}): AdministrativeDecision {
  if (
    input.requestedPublic === undefined ||
    input.requestedPublic === input.currentPublic
  ) {
    return allow('no-publication-change');
  }
  if (!input.actor) {
    return deny('anonymous');
  }
  const actorRole = fastifyRoleToV2Role(input.actor.role);
  if (actorRole === 'super_admin') {
    return deny('system-privilege-is-not-community-authority');
  }
  if (actorRole !== 'admin') {
    return deny('not-community-admin');
  }
  if (input.actor.communityId !== input.communityId) {
    return deny('cross-community');
  }
  return allow('community-admin');
}

export type AdministrativeAction =
  | 'enrollment'
  | 'membership_change'
  | 'system_account_create'
  | 'system_account_update'
  | 'publication_change';

/**
 * SPEC-V2 §7 audit entry for an administrative decision: actor ID, community
 * ID, action, resource IDs and outcome only. Never credentials, emails,
 * names, tokens or community content.
 */
export interface AdministrativeAuditEvent {
  event: 'administrative_decision';
  action: AdministrativeAction;
  actorId: number | null;
  actorCommunityId: number | null;
  communityId: number | null;
  resourceId: number | null;
  allowed: boolean;
  reason: AdministrativeDecisionReason;
}

export function createAdministrativeAuditEvent(input: {
  action: AdministrativeAction;
  actor: AdministrativeActor | null;
  communityId: number | null;
  resourceId?: number | null;
  decision: AdministrativeDecision;
}): AdministrativeAuditEvent {
  return {
    event: 'administrative_decision',
    action: input.action,
    actorId: input.actor?.id ?? null,
    actorCommunityId: input.actor?.communityId ?? null,
    communityId: input.communityId,
    resourceId: input.resourceId ?? null,
    allowed: input.decision.allowed,
    reason: input.decision.reason,
  };
}
