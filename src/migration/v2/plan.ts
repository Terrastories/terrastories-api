/**
 * Pure Rails -> canonical V2 transform planning (PLAN §3).
 *
 * Reads a verified Stage-1 bundle and produces canonical rows, archive
 * entries, per-row dispositions, MANUAL items and warnings. Nothing here
 * touches a target database, so planning is deterministic and testable.
 *
 * Rules: MANUAL never guesses (the row stays out of the canonical set and the
 * run fails unless the operator passes allow-manual); nothing is dropped
 * silently (every source row has exactly one status); display text defaults
 * are recorded (TRANSFORM_DEFAULT) with a warning, identifiers are never
 * invented.
 */
import { createHash } from 'node:crypto';
import {
  communityVisibilityToPhysical,
  storyVisibilityToPhysical,
  type StoryVisibility,
} from '../../policy/canonical-state.js';
import {
  BCRYPT_HASH_PATTERN,
  RAILS_BCRYPT_ALGORITHM,
  isCanonicalBcryptSalt,
  isStoredBcryptCost,
} from '../../shared/auth-policy.js';
import { deriveTopicNormalized } from '../../shared/utils/derived-columns.js';
import {
  descriptionPlainText,
  sanitizeDescriptionForMigration,
} from '../../shared/utils/safe-description.js';
import {
  PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH,
  isValidProtomapsApiKey,
  sanitizeMapboxStyleUrl,
  sanitizePublicMapboxToken,
} from '../../shared/utils/map-config.js';
import { normalizeSearchText } from '../../shared/utils/search-normalize.js';
import { storySlugBase } from '../../shared/utils/story-slug.js';
import { isSafeExternalMediaUrl } from '../../shared/schemas/public-content.js';
import type { SourceRow, VerifiedBundle } from './bundle-reader.js';
import {
  COLUMN_DISPOSITIONS,
  KNOWN_FLIPPER_KEYS,
  RAILS_MAP_PROJECTIONS,
} from './dispositions.js';

export type RowStatus =
  | 'imported'
  | 'not_selected'
  | 'manual'
  | 'excluded_dependency'
  | 'archived'
  | 'pending_media_slice';

export const ROW_STATUSES: readonly RowStatus[] = [
  'imported',
  'not_selected',
  'manual',
  'excluded_dependency',
  'archived',
  'pending_media_slice',
];

type Rejected = Exclude<RowStatus, 'imported'>;

export type CanonicalValue = string | number | null;
export type CanonicalRow = Record<string, CanonicalValue>;

export const CANONICAL_TABLES = [
  'communities',
  'users',
  'places',
  'speakers',
  'stories',
  'story_places',
  'story_speakers',
  'external_media_links',
  'community_map_configs',
] as const;
export type CanonicalTable = (typeof CANONICAL_TABLES)[number];

export interface ManualItem {
  table: string;
  id: string;
  code: string;
}

export interface WarningItem {
  code: string;
  table: string;
  id: string | null;
}

export interface ArchivedRow {
  table: string;
  id: string;
  reason: string;
  row: SourceRow;
}

export interface ArchivedField {
  table: string;
  id: string;
  column: string;
  disposition: string;
  value: string;
}

export interface TransformOptions {
  communities?: readonly string[];
  includeSystemUsers?: boolean;
}

export interface PendingAttachment {
  id: string;
  recordType: string;
  name: string;
  recordId: string;
  blobId: string;
  communityId: number | null;
  status: 'pending_media_slice' | 'not_selected';
}

export interface TransformPlan {
  selection: {
    mode: 'all' | 'community_allowlist';
    selectors: string[];
    communities: Array<{ id: number; slug: string | null }>;
    includeSystemUsers: boolean;
  };
  canonical: Record<CanonicalTable, CanonicalRow[]>;
  sourceCounts: Record<string, number>;
  statusCounts: Record<string, Record<RowStatus, number>>;
  manual: ManualItem[];
  warnings: WarningItem[];
  events: Record<string, number>;
  archivedRows: ArchivedRow[];
  archivedFields: ArchivedField[];
  pendingMedia: {
    blobs: Array<{
      id: string;
      key: string;
      byteSize: string;
      sha256: string | null;
      bundleDisposition: 'captured' | 'not_selected';
      status: 'pending_media_slice' | 'not_selected';
    }>;
    attachments: PendingAttachment[];
  };
  flipper: Array<{ key: string; enabled: boolean; disposition: string }>;
  unknownTables: string[];
  unregisteredColumns: string[];
  curriculumUseDetected: number;
  idRemaps: Record<string, Array<{ from: string; to: string }>>;
  /**
   * Highest source id per canonical table (including rows left out of the
   * canonical set), so new rows never reuse a legacy id.
   */
  sequenceFloors: Record<string, number>;
}

const ROLE_MAP: Record<string, string> = {
  '0': 'member',
  '1': 'editor',
  '2': 'admin',
  '3': 'viewer',
  '100': 'super_admin',
};

const PERMISSION: Record<string, StoryVisibility> = {
  '0': 'public',
  '1': 'community',
  '2': 'editors',
};

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toId(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

function parseBool(value: string | null | undefined): boolean | null {
  if (value === 'true' || value === 't') return true;
  if (value === 'false' || value === 'f') return false;
  return null;
}

interface ParsedTimestamp {
  ms: number;
  subMillisecond: boolean;
}

function parseTimestamp(
  value: string | null | undefined
): ParsedTimestamp | null {
  if (value === null || value === undefined) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(
      value
    );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac = ''] = match;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  );
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d) ||
    date.getUTCHours() !== Number(h)
  ) {
    return null;
  }
  const padded = frac.padEnd(6, '0');
  return {
    ms: ms + Number(padded.slice(0, 3)),
    subMillisecond: /[1-9]/.test(padded.slice(3)),
  };
}

function parseDecimal(
  value: string | null | undefined
): number | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (!/^-?\d+(\.\d{1,6})?$/.test(value)) return 'invalid';
  return Number(value);
}

function storySlug(title: string, id: number): string {
  const base = storySlugBase(title);
  return base.length > 0 ? base + '-' + id : 'story-' + id;
}

function descriptionCode(outcome: 'manual' | 'too_long'): string {
  return outcome === 'too_long'
    ? 'description_exceeds_max_length'
    : 'description_unprocessable';
}

function numericCompare(left: string, right: string): number {
  const l = toId(left);
  const r = toId(right);
  if (l !== null && r !== null) return l - r;
  if (l !== null) return -1;
  if (r !== null) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function textCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface Entity {
  community: number | null;
  status: RowStatus;
  createdMs?: number;
}

interface CommunityInfo {
  selected: boolean;
  accepted: boolean;
}

type ScopeResult =
  | { kind: 'ok'; id: number }
  | { kind: 'skip'; status: Rejected; code: string | null };

type RefKind = 'null' | 'ok' | 'missing' | 'cross' | 'excluded';

function refOutcome(
  kind: 'missing' | 'cross' | 'excluded'
): [Rejected, string] {
  if (kind === 'excluded') return ['excluded_dependency', 'reference_excluded'];
  if (kind === 'cross') return ['manual', 'cross_community_reference'];
  return ['manual', 'dangling_reference'];
}

export function planTransform(
  bundle: VerifiedBundle,
  options: TransformOptions = {}
): TransformPlan {
  const includeSystemUsers = options.includeSystemUsers === true;
  const rowCache = new Map<string, SourceRow[]>();
  const rows = (table: string): SourceRow[] => {
    let cached = rowCache.get(table);
    if (!cached) {
      cached = bundle
        .rows(table)
        .slice()
        .sort((a, b) => numericCompare(a.id ?? '', b.id ?? ''));
      rowCache.set(table, cached);
    }
    return cached;
  };
  const rowKey = (row: SourceRow, index: number): string =>
    row.id ?? row.version ?? row.key ?? String(index + 1);

  const canonical = Object.fromEntries(
    CANONICAL_TABLES.map((table) => [table, [] as CanonicalRow[]])
  ) as Record<CanonicalTable, CanonicalRow[]>;
  const statusCounts: Record<string, Record<RowStatus, number>> = {};
  const rowStatus = new Map<string, Map<string, RowStatus>>();
  const manual: ManualItem[] = [];
  const warnings: WarningItem[] = [];
  const events: Record<string, number> = {};
  const archivedRows: ArchivedRow[] = [];
  const archivedFields: ArchivedField[] = [];

  const event = (key: string): void => {
    events[key] = (events[key] ?? 0) + 1;
  };
  const warn = (code: string, table: string, id: string | null): void => {
    warnings.push({ code, table, id });
  };
  const setStatus = (table: string, id: string, status: RowStatus): void => {
    let byId = rowStatus.get(table);
    if (!byId) {
      byId = new Map();
      rowStatus.set(table, byId);
    }
    byId.set(id, status);
  };
  const reject = (
    table: string,
    row: SourceRow,
    status: Rejected,
    code: string | null
  ): void => {
    const id = row.id ?? '';
    setStatus(table, id, status);
    if (status === 'manual' || status === 'excluded_dependency') {
      manual.push({ table, id, code: code ?? status });
      archivedRows.push({ table, id, reason: code ?? status, row });
    }
  };
  const archiveField = (
    table: string,
    row: SourceRow,
    column: string,
    disposition: string
  ): void => {
    const value = row[column];
    if (value === null || value === undefined) return;
    archivedFields.push({
      table,
      id: row.id ?? '',
      column,
      disposition,
      value,
    });
  };

  // ---- source universe -------------------------------------------------
  const knownTables = new Set(Object.keys(COLUMN_DISPOSITIONS));
  const unknownTables = bundle.tableNames.filter((t) => !knownTables.has(t));
  const sourceCounts: Record<string, number> = {};
  for (const table of bundle.tableNames) {
    sourceCounts[table] = bundle.manifest.tables[table]?.rowCount ?? 0;
  }

  // ---- community selection ---------------------------------------------
  const communityRows = rows('communities');
  const selectors = [...new Set(options.communities ?? [])].sort();
  const selectedIds = new Set<number>();
  for (const selector of selectors) {
    const matches = communityRows.filter(
      (row) => row.id === selector || (row.slug ?? null) === selector
    );
    if (matches.length === 0) {
      throw new Error(
        'Community selector matched no source community: ' + selector
      );
    }
    for (const match of matches) {
      const id = toId(match.id);
      if (id !== null) selectedIds.add(id);
    }
  }
  const allMode = selectors.length === 0;
  // A partial (community_allowlist) capture is incomplete source data: a full
  // run over it would silently look like a whole-instance migration.
  if (bundle.manifest.complete !== true) {
    if (allMode) {
      throw new Error(
        'Bundle is a partial capture (manifest complete is not true); a full run is refused. Pass --community limited to communities captured in the bundle'
      );
    }
    const captured = new Set(
      (bundle.manifest.blobSelection?.communities ?? []).map((c) =>
        String(c.id)
      )
    );
    for (const id of selectedIds) {
      if (!captured.has(String(id))) {
        throw new Error(
          'Selected community ' +
            id +
            ' is outside the partial bundle capture selection; recapture it or select only captured communities'
        );
      }
    }
  }
  const communityInfo = new Map<number, CommunityInfo>();

  const describe = (
    table: string,
    row: SourceRow,
    column: string
  ): { html: string | null; plain: string | null } | 'manual' | 'too_long' => {
    const raw = row[column];
    if (raw === null || raw === undefined || raw.trim() === '') {
      return { html: null, plain: null };
    }
    try {
      const sanitized = sanitizeDescriptionForMigration(raw);
      if (sanitized.changed) {
        archiveField(table, row, column, 'ARCHIVE');
        event(table + '.' + column + ':sanitized');
      }
      if (sanitized.exceedsMaxLength) return 'too_long';
      if (sanitized.html === '') return { html: null, plain: null };
      const plain = descriptionPlainText(sanitized.html).trim();
      return { html: sanitized.html, plain: plain === '' ? null : plain };
    } catch {
      return 'manual';
    }
  };

  const timestamps = (
    table: string,
    row: SourceRow,
    columns: readonly string[]
  ): number[] | null => {
    const out: number[] = [];
    for (const column of columns) {
      const parsed = parseTimestamp(row[column]);
      if (!parsed) return null;
      if (parsed.subMillisecond) {
        archiveField(table, row, column, 'ARCHIVE');
        event(table + '.' + column + ':sub_millisecond_archived');
      }
      out.push(parsed.ms);
    }
    return out;
  };

  // communities
  {
    interface Candidate {
      row: SourceRow;
      id: number;
      slug: string;
      out: CanonicalRow;
    }
    const candidates: Candidate[] = [];
    for (const row of communityRows) {
      const id = toId(row.id);
      if (id === null) {
        reject('communities', row, 'manual', 'invalid_id');
        continue;
      }
      const selected = allMode || selectedIds.has(id);
      communityInfo.set(id, { selected, accepted: false });
      if (!selected) {
        setStatus('communities', row.id ?? '', 'not_selected');
        continue;
      }
      if (row.name === null || row.name.trim() === '') {
        reject('communities', row, 'manual', 'name_missing');
        continue;
      }
      const slug = row.slug === null ? '' : row.slug.trim();
      if (slug === '') {
        reject('communities', row, 'manual', 'slug_missing');
        continue;
      }
      if (slug.startsWith('deprovisioned-')) {
        reject('communities', row, 'manual', 'slug_reserved');
        continue;
      }
      const isPublic = parseBool(row.public);
      if (isPublic === null) {
        reject('communities', row, 'manual', 'public_invalid');
        continue;
      }
      const stamps = timestamps('communities', row, [
        'created_at',
        'updated_at',
      ]);
      if (!stamps) {
        reject('communities', row, 'manual', 'timestamp_invalid');
        continue;
      }
      const description = describe('communities', row, 'description');
      if (typeof description === 'string') {
        reject('communities', row, 'manual', descriptionCode(description));
        continue;
      }
      let locale = row.locale;
      if (locale === null || locale.trim() === '') {
        locale = 'en';
        event('communities.locale:TRANSFORM_DEFAULT');
        warn('locale_defaulted', 'communities', row.id ?? null);
      }
      candidates.push({
        row,
        id,
        slug,
        out: {
          id,
          name: row.name,
          description: description.html,
          description_plain: description.plain,
          slug,
          public_stories: communityVisibilityToPhysical(
            isPublic ? 'public' : 'private'
          )
            ? 1
            : 0,
          locale,
          is_active: 1,
          country: row.country,
          beta: parseBool(row.beta) === true ? 1 : 0,
          created_at: stamps[0] as number,
          updated_at: stamps[1] as number,
          deprovisioned_at: null,
        },
      });
    }
    const slugCounts = new Map<string, number>();
    for (const candidate of candidates) {
      slugCounts.set(candidate.slug, (slugCounts.get(candidate.slug) ?? 0) + 1);
    }
    for (const candidate of candidates) {
      if ((slugCounts.get(candidate.slug) ?? 0) > 1) {
        reject('communities', candidate.row, 'manual', 'slug_collision');
        continue;
      }
      const info = communityInfo.get(candidate.id);
      if (info) info.accepted = true;
      setStatus('communities', candidate.row.id ?? '', 'imported');
      canonical.communities.push(candidate.out);
      // The raw Rails beta flag is also archived as historical state (§3.1).
      archiveField('communities', candidate.row, 'beta', 'ARCHIVE');
    }
  }

  const scope = (cidText: string | null, strictMissing = true): ScopeResult => {
    const id = toId(cidText);
    const info = id === null ? undefined : communityInfo.get(id);
    if (id === null || !info) {
      if (allMode && strictMissing) {
        return { kind: 'skip', status: 'manual', code: 'community_missing' };
      }
      return { kind: 'skip', status: 'not_selected', code: null };
    }
    if (!info.selected) {
      return { kind: 'skip', status: 'not_selected', code: null };
    }
    if (!info.accepted) {
      return {
        kind: 'skip',
        status: 'excluded_dependency',
        code: 'community_excluded',
      };
    }
    return { kind: 'ok', id };
  };

  const skipRow = (
    table: string,
    row: SourceRow,
    result: Extract<ScopeResult, { kind: 'skip' }>
  ): void => {
    if (result.status === 'not_selected') {
      const id = toId(row.community_id ?? null);
      if (id === null || !communityInfo.has(id)) {
        warn('unattributed_row_not_selected', table, row.id ?? null);
      }
    }
    reject(table, row, result.status, result.code);
  };

  // ---- users -----------------------------------------------------------
  const userRows = rows('users');
  const userCommunity = new Map<string, string | null>();
  {
    interface UserCandidate {
      row: SourceRow;
      communityId: number | null;
      emailNorm: string | null;
      usernameNorm: string | null;
      out: CanonicalRow;
    }
    const candidates: UserCandidate[] = [];
    for (const row of userRows) {
      const idText = row.id ?? '';
      userCommunity.set(idText, row.community_id);
      const id = toId(row.id);
      if (id === null) {
        reject('users', row, 'manual', 'invalid_id');
        continue;
      }
      let communityId: number | null = null;
      if (row.community_id === null) {
        if (!includeSystemUsers) {
          if (!allMode) {
            setStatus('users', idText, 'not_selected');
            warn('system_user_not_selected', 'users', idText);
            continue;
          }
          // Full run: never drop a null-community account. A super_admin is
          // archived (restricted); anything else cannot be placed -> MANUAL.
          if (row.role !== '100') {
            reject('users', row, 'manual', 'null_community_user');
          } else {
            setStatus('users', idText, 'archived');
            warn('system_user_archived', 'users', idText);
            archivedRows.push({
              table: 'users',
              id: idText,
              reason: 'system_user_not_imported',
              row,
            });
          }
          continue;
        }
      } else {
        const result = scope(row.community_id);
        if (result.kind === 'skip') {
          skipRow('users', row, result);
          continue;
        }
        communityId = result.id;
      }

      const role = ROLE_MAP[row.role ?? ''];
      if (role === undefined) {
        reject(
          'users',
          row,
          'manual',
          row.role === null ? 'role_missing' : 'role_unknown'
        );
        continue;
      }
      const superAdmin = parseBool(row.super_admin);
      if (superAdmin === null) {
        reject('users', row, 'manual', 'super_admin_invalid');
        continue;
      }
      if ((role === 'super_admin') !== superAdmin) {
        reject('users', row, 'manual', 'role_super_admin_contradiction');
        continue;
      }
      if (role === 'super_admin' && communityId !== null) {
        reject('users', row, 'manual', 'super_admin_has_community');
        continue;
      }
      if (role !== 'super_admin' && communityId === null) {
        reject('users', row, 'manual', 'role_requires_community');
        continue;
      }

      const password = row.encrypted_password;
      let verifier: string | null = null;
      let algorithm: string | null = null;
      let salt: string | null = null;
      let params: string | null = null;
      if (password === null || password === '') {
        warn('code_only_account', 'users', idText);
        event('users.encrypted_password:no_verifier');
      } else if (BCRYPT_HASH_PATTERN.test(password)) {
        const cost = Number(password.slice(4, 6));
        const bcryptSalt = password.slice(7, 29);
        if (!isCanonicalBcryptSalt(bcryptSalt) || !isStoredBcryptCost(cost)) {
          reject('users', row, 'manual', 'password_hash_malformed');
          continue;
        }
        // Prelogin carries no bcrypt prefix, so the client always recomputes with the
        // canonical $2b$ prefix ($2a$/$2b$/$2y$ hashes are byte-identical past it).
        // Normalize the wrapped value accordingly; the raw hash stays in the archive.
        if (!password.startsWith('$2b$'))
          event('users.encrypted_password:prefix_normalized');
        verifier = sha256Hex('$2b$' + password.slice(4));
        algorithm = RAILS_BCRYPT_ALGORITHM;
        salt = bcryptSalt;
        params = JSON.stringify({ cost });
      } else {
        reject('users', row, 'manual', 'password_hash_malformed');
        continue;
      }

      const stamps = timestamps('users', row, ['created_at', 'updated_at']);
      if (!stamps) {
        reject('users', row, 'manual', 'timestamp_invalid');
        continue;
      }

      let email: string | null = row.email;
      if (email !== null && email.trim() === '') email = null;
      if (email === null) event('users.email:null');
      let username: string | null = row.username;
      if (username === null || username === '') {
        username = null;
        event('users.username:blank_to_null');
      }
      const displayName =
        row.name !== null && row.name.trim() !== '' ? row.name : null;
      const emailNorm = email === null ? null : normalizeSearchText(email);
      const usernameNorm =
        username === null ? null : normalizeSearchText(username);

      candidates.push({
        row,
        communityId,
        emailNorm,
        usernameNorm,
        out: {
          id,
          email,
          username,
          display_name: displayName,
          // Non-secret deterministic placeholder; the wrapped verifier lives in
          // the canonical verifier columns and the raw hash only in the archive.
          password_hash: sha256Hex('rails-migration-placeholder:' + id),
          password_verifier: verifier,
          password_algorithm: algorithm,
          password_salt: salt,
          password_params: params,
          username_normalized: usernameNorm,
          email_normalized: emailNorm,
          first_name: '',
          last_name: '',
          role,
          community_id: communityId,
          is_active: 1,
          created_at: stamps[0] as number,
          updated_at: stamps[1] as number,
        },
      });
    }

    // identity collisions (SPEC-V2 §10.2): never pick a winner
    const flagged = new Map<string, string>();
    const emailGroups = new Map<string, UserCandidate[]>();
    const usernameGroups = new Map<string, UserCandidate[]>();
    const emailOwners = new Map<string, UserCandidate[]>();
    for (const candidate of candidates) {
      if (candidate.emailNorm !== null) {
        const key =
          (candidate.communityId ?? 'null') + ':' + candidate.emailNorm;
        emailGroups.set(key, [...(emailGroups.get(key) ?? []), candidate]);
        emailOwners.set(candidate.emailNorm, [
          ...(emailOwners.get(candidate.emailNorm) ?? []),
          candidate,
        ]);
      }
      if (candidate.usernameNorm !== null) {
        usernameGroups.set(candidate.usernameNorm, [
          ...(usernameGroups.get(candidate.usernameNorm) ?? []),
          candidate,
        ]);
      }
    }
    for (const group of emailGroups.values()) {
      if (group.length > 1) {
        for (const c of group) flagged.set(c.row.id ?? '', 'email_collision');
      }
    }
    for (const group of usernameGroups.values()) {
      if (group.length > 1) {
        for (const c of group) {
          flagged.set(c.row.id ?? '', 'username_collision');
        }
      }
    }
    // A null-community super_admin shares the login namespace with every
    // community user at runtime (loginCandidates without a slug), so a shared
    // email would leave the super_admin unable to log in.
    for (const group of emailOwners.values()) {
      const hasSystem = group.some((c) => c.communityId === null);
      const hasCommunity = group.some((c) => c.communityId !== null);
      if (hasSystem && hasCommunity) {
        for (const c of group) {
          flagged.set(c.row.id ?? '', 'super_admin_email_collision');
        }
      }
    }
    for (const candidate of candidates) {
      if (candidate.usernameNorm === null) continue;
      const owners = (emailOwners.get(candidate.usernameNorm) ?? []).filter(
        (owner) => owner !== candidate
      );
      if (owners.length > 0 && !flagged.has(candidate.row.id ?? '')) {
        flagged.set(candidate.row.id ?? '', 'identifier_cross_kind_collision');
      }
    }

    for (const candidate of candidates) {
      const idText = candidate.row.id ?? '';
      const code = flagged.get(idText);
      if (code !== undefined) {
        reject('users', candidate.row, 'manual', code);
        continue;
      }
      setStatus('users', idText, 'imported');
      canonical.users.push(candidate.out);
      for (const [column, disposition] of [
        ['encrypted_password', 'ARCHIVE_RESTRICTED'],
        ['reset_password_token', 'ARCHIVE_RESTRICTED'],
        ['reset_password_sent_at', 'ARCHIVE'],
        ['remember_created_at', 'ARCHIVE'],
        ['sign_in_count', 'ARCHIVE'],
        ['current_sign_in_at', 'ARCHIVE'],
        ['last_sign_in_at', 'ARCHIVE'],
        ['current_sign_in_ip', 'ARCHIVE_RESTRICTED'],
        ['last_sign_in_ip', 'ARCHIVE_RESTRICTED'],
        ['role', 'ARCHIVE'],
        ['super_admin', 'ARCHIVE'],
      ] as const) {
        archiveField('users', candidate.row, column, disposition);
      }
    }
  }

  // ---- reference check ---------------------------------------------------
  const refCheck = (
    map: Map<number, Entity>,
    refText: string | null,
    community: number
  ): RefKind => {
    if (refText === null) return 'null';
    const id = toId(refText);
    const entity = id === null ? undefined : map.get(id);
    if (!entity) return 'missing';
    if (entity.community !== community) return 'cross';
    if (entity.status !== 'imported') return 'excluded';
    return 'ok';
  };

  // ---- places ------------------------------------------------------------
  const placeMap = new Map<number, Entity>();
  for (const row of rows('places')) {
    const id = toId(row.id);
    if (id === null) {
      reject('places', row, 'manual', 'invalid_id');
      continue;
    }
    const result = scope(row.community_id);
    if (result.kind === 'skip') {
      placeMap.set(id, {
        community: toId(row.community_id),
        status: result.status,
      });
      skipRow('places', row, result);
      continue;
    }
    const stamps = timestamps('places', row, ['created_at', 'updated_at']);
    const lat = parseDecimal(row.lat);
    const long = parseDecimal(row.long);
    let code: string | null = null;
    if (!stamps) code = 'timestamp_invalid';
    else if (lat === 'invalid' || long === 'invalid') {
      code = 'coordinate_invalid';
    } else if (
      (lat !== null && (lat < -90 || lat > 90)) ||
      (long !== null && (long < -180 || long > 180))
    ) {
      code = 'coordinate_out_of_range';
    }
    const description = describe('places', row, 'description');
    if (code === null && typeof description === 'string') {
      code = descriptionCode(description);
    }
    if (code !== null || !stamps || typeof description === 'string') {
      placeMap.set(id, { community: result.id, status: 'manual' });
      reject('places', row, 'manual', code);
      continue;
    }
    let name = row.name;
    if (name === null) {
      name = '';
      event('places.name:TRANSFORM_DEFAULT');
      warn('name_defaulted', 'places', row.id ?? null);
    }
    placeMap.set(id, { community: result.id, status: 'imported' });
    setStatus('places', row.id ?? '', 'imported');
    canonical.places.push({
      id,
      name,
      description: description.html,
      description_plain: description.plain,
      community_id: result.id,
      latitude: lat as number | null,
      longitude: long as number | null,
      type_of_place: row.type_of_place,
      region: row.region,
      is_restricted: 0,
      created_at: stamps[0] as number,
      updated_at: stamps[1] as number,
    });
  }

  // ---- speakers ----------------------------------------------------------
  const speakerMap = new Map<number, Entity>();
  for (const row of rows('speakers')) {
    const id = toId(row.id);
    if (id === null) {
      reject('speakers', row, 'manual', 'invalid_id');
      continue;
    }
    const result = scope(row.community_id);
    if (result.kind === 'skip') {
      speakerMap.set(id, {
        community: toId(row.community_id),
        status: result.status,
      });
      skipRow('speakers', row, result);
      continue;
    }
    const stamps = timestamps('speakers', row, ['created_at', 'updated_at']);
    let birthDate: string | null = null;
    let code: string | null = stamps ? null : 'timestamp_invalid';
    if (code === null && row.birthdate !== null) {
      const parsed = parseTimestamp(row.birthdate);
      if (!parsed) code = 'birthdate_invalid';
      else birthDate = new Date(parsed.ms).toISOString().slice(0, 10);
    }
    let status: Rejected = 'manual';
    if (code === null) {
      const check = refCheck(placeMap, row.birthplace_id, result.id);
      if (check === 'missing' || check === 'cross' || check === 'excluded') {
        [status, code] = refOutcome(check);
      }
    }
    if (code !== null || !stamps) {
      speakerMap.set(id, { community: result.id, status });
      reject('speakers', row, status, code);
      continue;
    }
    let name = row.name;
    if (name === null) {
      name = '';
      event('speakers.name:TRANSFORM_DEFAULT');
      warn('name_defaulted', 'speakers', row.id ?? null);
    }
    speakerMap.set(id, { community: result.id, status: 'imported' });
    setStatus('speakers', row.id ?? '', 'imported');
    archiveField('speakers', row, 'birthdate', 'ARCHIVE');
    canonical.speakers.push({
      id,
      name,
      community_id: result.id,
      birth_date: birthDate,
      birthplace_id: toId(row.birthplace_id),
      affiliation: row.speaker_community,
      created_at: stamps[0] as number,
      updated_at: stamps[1] as number,
    });
  }

  // ---- stories -----------------------------------------------------------
  const storyMap = new Map<number, Entity>();
  for (const row of rows('stories')) {
    const id = toId(row.id);
    if (id === null) {
      reject('stories', row, 'manual', 'invalid_id');
      continue;
    }
    const result = scope(row.community_id);
    if (result.kind === 'skip') {
      storyMap.set(id, {
        community: toId(row.community_id),
        status: result.status,
      });
      skipRow('stories', row, result);
      continue;
    }
    let status: Rejected = 'manual';
    let code: string | null = null;
    const visibility = PERMISSION[row.permission_level ?? ''];
    if (visibility === undefined) {
      code =
        row.permission_level === null
          ? 'permission_missing'
          : 'permission_unknown';
    }
    const stamps =
      code === null
        ? timestamps('stories', row, ['created_at', 'updated_at'])
        : null;
    if (code === null && !stamps) code = 'timestamp_invalid';
    let interviewed: ParsedTimestamp | null = null;
    if (code === null && row.date_interviewed !== null) {
      interviewed = parseTimestamp(row.date_interviewed);
      if (!interviewed) code = 'date_interviewed_invalid';
      else if (interviewed.subMillisecond) {
        archiveField('stories', row, 'date_interviewed', 'ARCHIVE');
      }
    }
    if (code === null) {
      for (const [map, column] of [
        [placeMap, 'interview_location_id'],
        [speakerMap, 'interviewer_id'],
      ] as const) {
        const check = refCheck(map, row[column] ?? null, result.id);
        if (check === 'missing' || check === 'cross' || check === 'excluded') {
          [status, code] = refOutcome(check);
          break;
        }
      }
    }
    const description = describe('stories', row, 'desc');
    if (code === null && typeof description === 'string') {
      code = descriptionCode(description);
    }
    if (
      code !== null ||
      !stamps ||
      typeof description === 'string' ||
      visibility === undefined
    ) {
      storyMap.set(id, { community: result.id, status });
      reject('stories', row, status, code);
      continue;
    }
    let title = row.title;
    if (title === null) {
      title = '';
      event('stories.title:TRANSFORM_DEFAULT');
      warn('title_defaulted', 'stories', row.id ?? null);
    }
    let language = row.language;
    if (language === null) {
      language = '';
      event('stories.language:TRANSFORM_DEFAULT');
      warn('language_defaulted', 'stories', row.id ?? null);
    }
    const physical = storyVisibilityToPhysical(visibility);
    storyMap.set(id, {
      community: result.id,
      status: 'imported',
      createdMs: stamps[0] as number,
    });
    setStatus('stories', row.id ?? '', 'imported');
    canonical.stories.push({
      id,
      title,
      description: description.html,
      description_plain: description.plain,
      slug: storySlug(title, id),
      community_id: result.id,
      created_by: null,
      is_restricted: physical.isRestricted ? 1 : 0,
      privacy_level: physical.privacyLevel,
      topic: row.topic,
      topic_normalized: deriveTopicNormalized(row.topic),
      media_urls: '[]',
      language,
      tags: '[]',
      date_interviewed: interviewed ? interviewed.ms : null,
      interview_location_id: toId(row.interview_location_id),
      interviewer_id: toId(row.interviewer_id),
      created_at: stamps[0] as number,
      updated_at: stamps[1] as number,
    });
  }

  // ---- story edges -------------------------------------------------------
  // Orphan rows (an endpoint without a source row) are MANUAL when their
  // surviving endpoint belongs to a selected community, and in a full run
  // (SPEC-V2 §10.2). In a scoped run an orphan unrelated to the selection is
  // recorded as not_selected.
  const orphan = (
    table: string,
    row: SourceRow,
    survivor: number | null | undefined,
    code: string
  ): void => {
    const related =
      survivor !== null &&
      survivor !== undefined &&
      communityInfo.get(survivor)?.selected === true;
    if (allMode || related) {
      reject(table, row, 'manual', code);
    } else {
      warn('orphan_row_not_selected', table, row.id ?? null);
      reject(table, row, 'not_selected', null);
    }
  };
  const resolveStory = (
    table: string,
    row: SourceRow,
    story: Entity,
    storyId: number
  ): { storyId: number; community: number; createdMs: number } | null => {
    if (story.status === 'not_selected') {
      reject(table, row, 'not_selected', null);
      return null;
    }
    if (story.status !== 'imported' || story.community === null) {
      reject(table, row, 'excluded_dependency', 'story_excluded');
      return null;
    }
    return {
      storyId,
      community: story.community,
      createdMs: story.createdMs ?? 0,
    };
  };
  for (const [table, canonicalTable, otherMap, otherColumn] of [
    ['places_stories', 'story_places', placeMap, 'place_id'],
    ['speaker_stories', 'story_speakers', speakerMap, 'speaker_id'],
  ] as const) {
    const perStory = new Map<number, number>();
    for (const row of rows(table)) {
      const id = toId(row.id);
      if (id === null) {
        reject(table, row, 'manual', 'invalid_id');
        continue;
      }
      const storyId = toId(row.story_id);
      const story = storyId === null ? undefined : storyMap.get(storyId);
      const otherId = toId(row[otherColumn]);
      const other = otherId === null ? undefined : otherMap.get(otherId);
      if (!story || !other || storyId === null) {
        if (!story && !other) orphan(table, row, null, 'orphan_edge');
        else if (!story) orphan(table, row, other?.community, 'story_missing');
        else {
          orphan(
            table,
            row,
            story.community,
            otherColumn === 'place_id' ? 'place_missing' : 'speaker_missing'
          );
        }
        continue;
      }
      const resolved = resolveStory(table, row, story, storyId);
      if (!resolved) continue;
      const check = refCheck(
        otherMap,
        row[otherColumn] ?? null,
        resolved.community
      );
      if (check !== 'ok') {
        const [status, code] =
          check === 'null'
            ? (['manual', 'dangling_reference'] as const)
            : refOutcome(check);
        reject(table, row, status, code);
        continue;
      }
      const ordinal = perStory.get(resolved.storyId) ?? 0;
      perStory.set(resolved.storyId, ordinal + 1);
      setStatus(table, row.id ?? '', 'imported');
      canonical[canonicalTable].push({
        id,
        community_id: resolved.community,
        story_id: resolved.storyId,
        [otherColumn]: otherId,
        sort_order: ordinal,
        created_at: resolved.createdMs,
        updated_at: resolved.createdMs,
      });
    }
  }

  // media_links -> external_media_links
  {
    const perStory = new Map<number, number>();
    for (const row of rows('media_links')) {
      const id = toId(row.id);
      if (id === null) {
        reject('media_links', row, 'manual', 'invalid_id');
        continue;
      }
      const linkStoryId = toId(row.story_id);
      const linkStory =
        linkStoryId === null ? undefined : storyMap.get(linkStoryId);
      if (!linkStory || linkStoryId === null) {
        orphan('media_links', row, null, 'story_missing');
        continue;
      }
      const story = resolveStory('media_links', row, linkStory, linkStoryId);
      if (!story) continue;
      if (row.url === null || row.url.trim() === '') {
        reject('media_links', row, 'manual', 'url_missing');
        continue;
      }
      if (row.url.length > 2048 || !isSafeExternalMediaUrl(row.url)) {
        reject('media_links', row, 'manual', 'url_invalid');
        continue;
      }
      const stamps = timestamps('media_links', row, ['created_at']);
      if (!stamps) {
        reject('media_links', row, 'manual', 'timestamp_invalid');
        continue;
      }
      const ordinal = perStory.get(story.storyId) ?? 0;
      perStory.set(story.storyId, ordinal + 1);
      setStatus('media_links', row.id ?? '', 'imported');
      archiveField('media_links', row, 'updated_at', 'ARCHIVE');
      canonical.external_media_links.push({
        id,
        community_id: story.community,
        story_id: story.storyId,
        url: row.url,
        ordinal,
        created_at: stamps[0] as number,
      });
    }
  }

  // ---- themes -> community_map_configs ----------------------------------
  const themeRows = rows('themes');
  {
    const perCommunity = new Map<string, number>();
    for (const row of themeRows) {
      const key = row.community_id ?? 'null';
      perCommunity.set(key, (perCommunity.get(key) ?? 0) + 1);
    }
    const decimalColumns = [
      'center_lat',
      'center_long',
      'sw_boundary_lat',
      'sw_boundary_long',
      'ne_boundary_lat',
      'ne_boundary_long',
      'zoom',
      'pitch',
      'bearing',
    ] as const;
    for (const row of themeRows) {
      const id = toId(row.id);
      if (id === null) {
        reject('themes', row, 'manual', 'invalid_id');
        continue;
      }
      const result = scope(row.community_id);
      if (result.kind === 'skip') {
        skipRow('themes', row, result);
        continue;
      }
      if ((perCommunity.get(row.community_id ?? 'null') ?? 0) > 1) {
        reject('themes', row, 'manual', 'multiple_themes_for_community');
        continue;
      }
      const stamps = timestamps('themes', row, ['created_at', 'updated_at']);
      const decimals: Record<string, number | null | 'invalid'> = {};
      for (const column of decimalColumns) {
        decimals[column] = parseDecimal(row[column]);
      }
      let code: string | null = stamps ? null : 'timestamp_invalid';
      if (code === null && Object.values(decimals).includes('invalid')) {
        code = 'decimal_invalid';
      }
      const swLat = decimals.sw_boundary_lat;
      const neLat = decimals.ne_boundary_lat;
      if (
        code === null &&
        typeof swLat === 'number' &&
        typeof neLat === 'number' &&
        swLat > neLat
      ) {
        code = 'bounds_inverted';
      }
      let projection: string | null = null;
      if (code === null && row.map_projection !== null) {
        const index = /^\d+$/.test(row.map_projection)
          ? Number(row.map_projection)
          : -1;
        projection = RAILS_MAP_PROJECTIONS[index] ?? null;
        if (projection === null) code = 'projection_unknown';
      }
      if (code !== null || !stamps) {
        reject('themes', row, 'manual', code);
        continue;
      }
      setStatus('themes', row.id ?? '', 'imported');
      // Provider configuration (#277 canonical map-config): validated with the
      // same helpers the API uses. Anything not imported stays in the
      // restricted archive; credential values are never logged or warned.
      const themeId = row.id ?? '';
      const rawStyle = row.mapbox_style_url;
      const rawToken = row.mapbox_access_token;
      const rawProtomapsKey = row.protomaps_api_key;
      const style = sanitizeMapboxStyleUrl(rawStyle);
      const token = sanitizePublicMapboxToken(rawToken);
      if (rawStyle !== null && rawStyle.trim() !== '' && style === null) {
        warn('mapbox_style_url_invalid', 'themes', themeId);
      }
      if (rawToken !== null && rawToken.trim() !== '' && token === null) {
        warn('mapbox_token_not_public', 'themes', themeId);
      }
      let importedStyle = style;
      let importedToken = token;
      if ((style === null) !== (token === null)) {
        // style/token pair rule: one valid half without the other is useless
        // and risky, so import neither.
        importedStyle = null;
        importedToken = null;
        warn('mapbox_pair_incomplete', 'themes', themeId);
      }
      if (importedStyle === null) {
        archiveField('themes', row, 'mapbox_style_url', 'ARCHIVE');
      }
      if (importedToken === null) {
        archiveField(
          'themes',
          row,
          'mapbox_access_token',
          'ARCHIVE_RESTRICTED'
        );
      }
      let protomapsKey: string | null = null;
      if (rawProtomapsKey !== null && rawProtomapsKey.trim() !== '') {
        if (isValidProtomapsApiKey(rawProtomapsKey)) {
          protomapsKey = rawProtomapsKey.trim();
        } else {
          warn('protomaps_key_invalid', 'themes', themeId);
        }
      }
      if (protomapsKey === null) {
        archiveField('themes', row, 'protomaps_api_key', 'ARCHIVE_RESTRICTED');
      }
      let basemapStyle: string | null = null;
      if (row.protomaps_basemap_style !== null) {
        if (
          row.protomaps_basemap_style.length <=
          PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH
        ) {
          basemapStyle = row.protomaps_basemap_style;
        } else {
          warn('protomaps_basemap_style_invalid', 'themes', themeId);
          archiveField('themes', row, 'protomaps_basemap_style', 'ARCHIVE');
        }
      }
      // Rails resets expose_mapbox_credentials when a community goes private;
      // keep the same invariant instead of importing a contradictory pair.
      const communityIsPublic =
        canonical.communities.find((c) => c.id === result.id)
          ?.public_stories === 1;
      let expose = parseBool(row.expose_mapbox_credentials) === true;
      if (expose && !communityIsPublic) {
        expose = false;
        warn('expose_mapbox_credentials_reset_private', 'themes', themeId);
      }
      for (const [column, disposition] of [
        ['id', 'ARCHIVE'],
        ['active', 'ARCHIVE'],
        ['expose_mapbox_credentials', 'ARCHIVE'],
      ] as const) {
        archiveField('themes', row, column, disposition);
      }
      canonical.community_map_configs.push({
        community_id: result.id,
        mapbox_style_url: importedStyle,
        mapbox_access_token: importedToken,
        expose_mapbox_credentials: expose ? 1 : 0,
        mapbox_3d: parseBool(row.mapbox_3d) ? 1 : 0,
        protomaps_api_key: protomapsKey,
        protomaps_basemap_style: basemapStyle,
        center_latitude: decimals.center_lat as number | null,
        center_longitude: decimals.center_long as number | null,
        south_west_latitude: swLat as number | null,
        south_west_longitude: decimals.sw_boundary_long as number | null,
        north_east_latitude: neLat as number | null,
        north_east_longitude: decimals.ne_boundary_long as number | null,
        zoom: decimals.zoom as number | null,
        pitch: decimals.pitch as number | null,
        bearing: decimals.bearing as number | null,
        three_dimensional:
          row.mapbox_3d === null ? null : parseBool(row.mapbox_3d) ? 1 : 0,
        projection,
        static_map_file_id: null,
        created_at: stamps[0] as number,
        updated_at: stamps[1] as number,
      });
    }
  }

  // ---- curriculums (archive) --------------------------------------------
  let curriculumUseDetected = 0;
  const curriculumStatus = new Map<string, RowStatus>();
  for (const row of rows('curriculums')) {
    const owner = userCommunity.get(row.user_id ?? '') ?? null;
    const result = scope(owner, false);
    // Full run: every curriculum is archived, even with a null/missing owner.
    // Scoped run: archived only when the owner's community is selected.
    const status: RowStatus =
      !allMode && result.kind === 'skip' && result.status === 'not_selected'
        ? 'not_selected'
        : 'archived';
    curriculumStatus.set(row.id ?? '', status);
    setStatus('curriculums', row.id ?? '', status);
    if (status === 'archived') {
      curriculumUseDetected += 1;
      archivedRows.push({
        table: 'curriculums',
        id: row.id ?? '',
        reason: 'archive_only_table',
        row,
      });
    }
  }
  for (const row of rows('curriculum_stories')) {
    const storyId = toId(row.story_id);
    const storyCommunity =
      storyId === null ? null : (storyMap.get(storyId)?.community ?? null);
    const storySelected =
      storyCommunity !== null &&
      communityInfo.get(storyCommunity)?.selected === true;
    const status: RowStatus =
      allMode ||
      storySelected ||
      curriculumStatus.get(row.curriculum_id ?? '') === 'archived'
        ? 'archived'
        : 'not_selected';
    setStatus('curriculum_stories', row.id ?? '', status);
    if (status === 'archived') {
      archivedRows.push({
        table: 'curriculum_stories',
        id: row.id ?? '',
        reason: 'archive_only_table',
        row,
      });
    }
  }

  // ---- operational tables ------------------------------------------------
  const flipper: TransformPlan['flipper'] = [];
  {
    const gates = rows('flipper_gates');
    for (const feature of rows('flipper_features')) {
      const key = feature.key ?? '';
      const enabled = gates.some(
        (gate) =>
          gate.feature_key === key &&
          gate.value !== null &&
          gate.value !== '' &&
          gate.value !== 'false' &&
          gate.value !== '0'
      );
      const known = KNOWN_FLIPPER_KEYS.includes(key);
      flipper.push({
        key,
        enabled,
        disposition: known ? 'IMPROVE' : enabled ? 'MANUAL' : 'ARCHIVE',
      });
      if (!known && enabled) {
        manual.push({
          table: 'flipper_features',
          id: feature.id ?? '',
          code: 'unknown_enabled_flag',
        });
      }
    }
    for (const table of [
      'flipper_features',
      'flipper_gates',
      'schema_migrations',
      'ar_internal_metadata',
    ]) {
      for (const [index, row] of rows(table).entries()) {
        const id = rowKey(row, index);
        setStatus(table, id, 'archived');
        archivedRows.push({ table, id, reason: 'archive_only_table', row });
      }
    }
  }
  flipper.sort((a, b) => textCompare(a.key, b.key));

  // ---- pending media (S3 slice) -----------------------------------------
  const attachments = rows('active_storage_attachments');
  const variantRecords = rows('active_storage_variant_records');
  const mediaRows = rows('media');
  const themeCommunity = new Map(
    themeRows.map((row) => [row.id ?? '', row.community_id] as const)
  );
  const mediaStory = new Map(
    mediaRows.map((row) => [row.id ?? '', row.story_id] as const)
  );
  type Owner = number | 'system' | null;
  const entityOwner = (map: Map<number, Entity>, idText: string): Owner => {
    const community = map.get(toId(idText) ?? -1)?.community ?? null;
    return community !== null && communityInfo.has(community)
      ? community
      : null;
  };
  const ownerOf = (recordType: string, recordId: string, depth = 0): Owner => {
    if (depth > 3) return null;
    switch (recordType) {
      case 'Community': {
        const id = toId(recordId);
        return id !== null && communityInfo.has(id) ? id : null;
      }
      case 'Place':
        return entityOwner(placeMap, recordId);
      case 'Speaker':
        return entityOwner(speakerMap, recordId);
      case 'User': {
        if (!userCommunity.has(recordId)) return null;
        const community = userCommunity.get(recordId) ?? null;
        if (community === null) return 'system';
        const id = toId(community);
        return id !== null && communityInfo.has(id) ? id : null;
      }
      case 'Theme': {
        const id = toId(themeCommunity.get(recordId) ?? null);
        return id !== null && communityInfo.has(id) ? id : null;
      }
      case 'Media':
        return entityOwner(storyMap, mediaStory.get(recordId) ?? '');
      case 'ActiveStorage::VariantRecord': {
        const variant = variantRecords.find((row) => row.id === recordId);
        return variant ? viaBlob(variant.blob_id ?? '', depth + 1) : null;
      }
      case 'ActiveStorage::Blob':
        return viaBlob(recordId, depth + 1);
      default:
        return null;
    }
  };
  const viaBlob = (blobId: string, depth: number): Owner => {
    for (const attachment of attachments) {
      if (
        attachment.blob_id === blobId &&
        attachment.record_type !== 'ActiveStorage::VariantRecord' &&
        attachment.record_type !== 'ActiveStorage::Blob'
      ) {
        return ownerOf(
          attachment.record_type ?? '',
          attachment.record_id ?? '',
          depth
        );
      }
    }
    return null;
  };
  // pending_media_slice applies only to rows reachable from a selected
  // community (the same reachability as the Stage-1 blob allowlist). Rows
  // without an attributable owner are MANUAL in full runs, not_selected in
  // scoped runs.
  const settleMedia = (
    table: string,
    row: SourceRow,
    owner: Owner,
    unattributedCode: string
  ): 'pending_media_slice' | 'not_selected' | null => {
    if (owner === null) {
      orphan(table, row, null, unattributedCode);
      return null;
    }
    if (owner === 'system') {
      if (includeSystemUsers) {
        setStatus(table, row.id ?? '', 'pending_media_slice');
        return 'pending_media_slice';
      }
      setStatus(table, row.id ?? '', 'not_selected');
      return 'not_selected';
    }
    const info = communityInfo.get(owner);
    if (!info?.selected) {
      setStatus(table, row.id ?? '', 'not_selected');
      return 'not_selected';
    }
    if (!info.accepted) {
      reject(table, row, 'excluded_dependency', 'community_excluded');
      return null;
    }
    setStatus(table, row.id ?? '', 'pending_media_slice');
    return 'pending_media_slice';
  };
  const pendingAttachments: PendingAttachment[] = [];
  for (const row of attachments) {
    const owner = ownerOf(row.record_type ?? '', row.record_id ?? '');
    const status = settleMedia(
      'active_storage_attachments',
      row,
      owner,
      'attachment_unattributable'
    );
    if (status === null) continue;
    pendingAttachments.push({
      id: row.id ?? '',
      recordType: row.record_type ?? '',
      name: row.name ?? '',
      recordId: row.record_id ?? '',
      blobId: row.blob_id ?? '',
      communityId: typeof owner === 'number' ? owner : null,
      status,
    });
  }
  for (const row of mediaRows) {
    settleMedia(
      'media',
      row,
      entityOwner(storyMap, row.story_id ?? ''),
      'media_story_missing'
    );
  }
  for (const row of variantRecords) {
    settleMedia(
      'active_storage_variant_records',
      row,
      ownerOf('ActiveStorage::VariantRecord', row.id ?? ''),
      'variant_unattributable'
    );
  }
  const pendingBlobs = bundle.manifest.blobs
    .map((blob) => ({
      id: blob.id,
      key: blob.key,
      byteSize: blob.byteSize,
      sha256: blob.sha256,
      bundleDisposition: blob.disposition,
      status:
        blob.disposition === 'captured'
          ? ('pending_media_slice' as const)
          : ('not_selected' as const),
    }))
    .sort((a, b) => numericCompare(a.id, b.id));
  for (const blob of pendingBlobs) {
    setStatus('active_storage_blobs', blob.id, blob.status);
  }

  // ---- unknown tables and unregistered columns ---------------------------
  for (const table of unknownTables) {
    warn('unknown_table_archived', table, null);
    for (const [index, row] of rows(table).entries()) {
      const id = rowKey(row, index);
      setStatus(table, id, 'archived');
      archivedRows.push({ table, id, reason: 'unknown_table', row });
    }
  }
  const unregisteredColumns: string[] = [];
  for (const table of bundle.tableNames) {
    const registry = COLUMN_DISPOSITIONS[table];
    if (!registry) continue;
    for (const column of bundle.manifest.tables[table]?.columns ?? []) {
      if (column.columnName in registry) continue;
      unregisteredColumns.push(table + '.' + column.columnName);
      warn('unregistered_column_archived', table, null);
      for (const row of rows(table)) {
        if (rowStatus.get(table)?.get(row.id ?? '') === 'not_selected')
          continue;
        archiveField(table, row, column.columnName, 'ARCHIVE');
      }
    }
  }
  unregisteredColumns.sort();

  // ---- counts ------------------------------------------------------------
  for (const table of bundle.tableNames) {
    const counts = Object.fromEntries(
      ROW_STATUSES.map((status) => [status, 0])
    ) as Record<RowStatus, number>;
    const byId = rowStatus.get(table);
    for (const [index, row] of rows(table).entries()) {
      const status = byId?.get(rowKey(row, index));
      if (status === undefined) {
        throw new Error(
          'Internal error: source row without disposition (' + table + ')'
        );
      }
      counts[status] += 1;
    }
    statusCounts[table] = counts;
  }

  const sequenceFloors: Record<string, number> = {};
  for (const [canonicalTable, sourceTable] of [
    ['communities', 'communities'],
    ['users', 'users'],
    ['places', 'places'],
    ['speakers', 'speakers'],
    ['stories', 'stories'],
    ['story_places', 'places_stories'],
    ['story_speakers', 'speaker_stories'],
    ['external_media_links', 'media_links'],
  ] as const) {
    let max = 0;
    for (const row of rows(sourceTable)) {
      const id = toId(row.id);
      if (id !== null && id > max) max = id;
    }
    sequenceFloors[canonicalTable] = max;
  }

  for (const table of CANONICAL_TABLES) {
    const key = table === 'community_map_configs' ? 'community_id' : 'id';
    canonical[table].sort((a, b) => (a[key] as number) - (b[key] as number));
  }
  const byKey = (
    a: { table: string; id: string | null; code: string },
    b: { table: string; id: string | null; code: string }
  ): number =>
    textCompare(
      a.table + '\x00' + (a.id ?? '') + '\x00' + a.code,
      b.table + '\x00' + (b.id ?? '') + '\x00' + b.code
    );
  manual.sort(byKey);
  warnings.sort(byKey);
  archivedRows.sort((a, b) =>
    a.table === b.table
      ? numericCompare(a.id, b.id)
      : textCompare(a.table, b.table)
  );
  archivedFields.sort((a, b) => {
    if (a.table !== b.table) return textCompare(a.table, b.table);
    if (a.id !== b.id) return numericCompare(a.id, b.id);
    return textCompare(a.column, b.column);
  });

  return {
    selection: {
      mode: allMode ? 'all' : 'community_allowlist',
      selectors,
      communities: communityRows
        .filter((row) => {
          const id = toId(row.id);
          return id !== null && communityInfo.get(id)?.selected === true;
        })
        .map((row) => ({ id: toId(row.id) as number, slug: row.slug })),
      includeSystemUsers,
    },
    canonical,
    sourceCounts,
    statusCounts,
    manual,
    warnings,
    events: Object.fromEntries(
      Object.entries(events).sort(([a], [b]) => textCompare(a, b))
    ),
    archivedRows,
    archivedFields,
    pendingMedia: { blobs: pendingBlobs, attachments: pendingAttachments },
    flipper,
    unknownTables,
    unregisteredColumns,
    curriculumUseDetected,
    idRemaps: Object.fromEntries(CANONICAL_TABLES.map((t) => [t, []])),
    sequenceFloors,
  };
}
