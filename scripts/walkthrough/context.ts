/**
 * Shared types and helpers for the persona chapters.
 */
import type { Actor, Reply } from './client.js';
import {
  loginMaterial,
  newVerifier,
  randomPassword,
  type PreloginAnswer,
} from './kdf.js';
import { dig, type Walk } from './walk.js';

export type WorkersPlan = 'free' | 'paid';

export interface Config {
  baseUrl: string;
  /**
   * Slug of the real (migrated) community. It is only ever READ: every
   * mutating chapter runs in the disposable play community instead.
   */
  community: string;
  /** Real admin of that community; used only with loginRealAdmin. */
  adminIdentifier?: string;
  adminPassword?: string;
  superIdentifier?: string;
  superPassword?: string;
  bootstrapSecret?: string;
  setupFromBootstrap: boolean;
  allowDestructive: boolean;
  /** Explicitly log in as the real admin (a migrated bcrypt login upgrades the stored verifier to Argon2id). */
  loginRealAdmin?: boolean;
  /**
   * The target is a Cloudflare D1 database (a Worker deployment): one committed
   * import per UTC day for the whole database. The import chapter then commits
   * once and asserts the refusal of the second on Workers Free. Set by --d1 (or WT_D1=1).
   */
  d1?: boolean;
  /**
   * Workers plan for `--d1` runs (`'free'` or `'paid'`, default `'free'`).
   * Set by `--workers-plan`.
   */
  workersPlan?: WorkersPlan;
}

/** The disposable community every mutating chapter runs in. */
export interface PlayCommunity {
  slug: string;
  /** Absent when the install was bootstrapped by the script (no super admin to disable it). */
  id?: number;
  /** Script-created admin ("Ana"). */
  adminIdentifier: string;
  adminPassword: string;
  source: 'provisioned' | 'bootstrap';
}

export interface Account {
  key: string;
  displayName: string;
  username: string;
  email: string;
  role: string;
  id?: number;
  password?: string;
  loginCode?: string;
}

export interface State {
  /** Accounts the walkthrough created, by short key. */
  accounts: Record<string, Account>;
  ids: Record<string, number>;
  files: Record<string, string>;
  attachments: Record<string, number>;
  /** Created content to remove during cleanup. */
  stories: number[];
  places: number[];
  speakers: number[];
  imports: number[];
  /** Every community this run created, registered at once so cleanup disables it. */
  communities: Array<{ id: number; slug: string }>;
  /** Every file id uploaded in the run, so a stray one is still cleared. */
  uploaded: string[];
  /** The disposable community; set by the play provisioning or the bootstrap chapter. */
  play?: PlayCommunity;
  /** Set once the cleanup chapter has run (it must run at most once). */
  cleanedUp?: boolean;
  /** Counts read from the real community by the read-only check. */
  targetCounts: Record<string, number | string>;
  /** Snapshot of the play community (raw admin reads) before the walkthrough changes it. */
  snapshot?: {
    description: string | null;
    visibility: string;
    mapConfig: Record<string, unknown> | null;
  };
  actors: Record<string, Actor>;
  /** The disposable community, when the super admin chapter made one. */
  lab?: { id: number; slug: string; name: string };
  notes: string[];
}

export interface Ctx {
  w: Walk;
  cfg: Config;
  s: State;
}

export function newState(): State {
  return {
    accounts: {},
    ids: {},
    files: {},
    attachments: {},
    stories: [],
    places: [],
    speakers: [],
    imports: [],
    uploaded: [],
    communities: [],
    actors: {},
    notes: [],
    targetCounts: {},
  };
}

/** A paged read that is not a 200 is an error, never the end of the list. */
export function requireOk(page: Reply, what: string): void {
  if (page.status === 200) return;
  const code = dig(page, 'code');
  throw new Error(
    `${what}: expected 200 but got ${page.status}${typeof code === 'string' ? ` (${code})` : ''}`
  );
}

/**
 * Walk a paged list (limit/offset, meta.hasNextPage) and return every row.
 * Never stops at the first page. `rowsOf` picks the array out of the reply.
 */
export async function listAll<T>(
  actor: Actor,
  path: string,
  rowsOf: (reply: Reply) => T[],
  limit = 100
): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; offset < 10_000; offset += limit) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await actor.call(
      'GET',
      `${path}${sep}limit=${limit}&offset=${offset}`
    );
    requireOk(page, `list ${path}`);
    const rows = rowsOf(page);
    out.push(...rows);
    const more = dig(page, 'meta', 'hasNextPage');
    if (more === true || (more === undefined && rows.length === limit))
      continue;
    break;
  }
  return out;
}

/** The offset of the page that holds the first row matching `pred` (0 when none). */
export async function offsetOfMatch<T>(
  actor: Actor,
  path: string,
  rowsOf: (reply: Reply) => T[],
  pred: (row: T) => boolean,
  limit = 100
): Promise<number> {
  for (let offset = 0; offset < 10_000; offset += limit) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await actor.call(
      'GET',
      `${path}${sep}limit=${limit}&offset=${offset}`
    );
    requireOk(page, `search ${path}`);
    const rows = rowsOf(page);
    if (rows.some(pred)) return offset;
    const more = dig(page, 'meta', 'hasNextPage');
    if (more === true || (more === undefined && rows.length === limit))
      continue;
    break;
  }
  return 0;
}

/** Record a created community for cleanup (idempotent). */
export function registerCommunity(ctx: Ctx, id: number, slug: string): void {
  if (!ctx.s.communities.some((c) => c.id === id))
    ctx.s.communities.push({ id, slug });
}

/** The disposable community; throws when none exists (never falls back to the real one). */
export function playOf(ctx: Ctx): PlayCommunity {
  if (!ctx.s.play)
    throw new Error('no disposable community exists for this run');
  return ctx.s.play;
}

export const val = (reply: Reply, ...keys: Array<string | number>) =>
  dig(reply, ...keys);

export const num = (reply: Reply, ...keys: Array<string | number>): number => {
  const v = dig(reply, ...keys);
  if (typeof v !== 'number')
    throw new Error(`missing number at ${keys.join('.')}`);
  return v;
};

export const str = (reply: Reply, ...keys: Array<string | number>): string => {
  const v = dig(reply, ...keys);
  if (typeof v !== 'string')
    throw new Error(`missing string at ${keys.join('.')}`);
  return v;
};

/** Plain "label: value" line for a screen description. */
export const field = (label: string, value: unknown): string =>
  `${label}: ${value === null || value === undefined ? '(empty)' : String(value)}`;

/** The browser stretches the password with the stored salt (silent prelogin). */
export async function deriveKey(
  ctx: Ctx,
  actor: Actor,
  identifier: string,
  password: string,
  communitySlug?: string
): Promise<string> {
  const pre = await actor.call('POST', '/v2/auth/prelogin', {
    json: { identifier, ...(communitySlug ? { communitySlug } : {}) },
    noCookie: true,
  });
  const material = await loginMaterial(password, pre.json as PreloginAnswer);
  ctx.w.secret(material.derivedKey);
  return material.derivedKey;
}

/**
 * The login screen: prelogin, client stretching, submit. A migrated Rails
 * account sends its bcrypt hash and upgrades to Argon2id in the same request.
 */
export async function signIn(
  ctx: Ctx,
  actor: Actor,
  identifier: string,
  password: string,
  options: {
    communitySlug?: string;
    deviceSession?: boolean;
    who?: string;
    covers?: string[];
  } = {}
): Promise<{ upgraded: boolean; reply: Reply }> {
  const { w } = ctx;
  w.secret(password);
  const pre = await w.step({
    who: actor,
    say: `opens the login page and types their login name; the browser asks how to stretch the password`,
    method: 'POST',
    path: '/v2/auth/prelogin',
    json: {
      identifier,
      ...(options.communitySlug
        ? { communitySlug: options.communitySlug }
        : {}),
    },
    noCookie: true,
    expect: 200,
    covers: ['A05'],
    show: (r) => {
      const algo = String(val(r, 'algorithm'));
      return [
        field('algorithm', algo),
        algo.includes('bcrypt')
          ? 'this is a migrated Rails password (bcrypt, wrapped); it will be upgraded to Argon2id on this login'
          : 'Argon2id parameters and salt for the in-browser stretching (progress bar in a UI)',
      ];
    },
  });
  const answer = pre.json as PreloginAnswer;
  const material = await loginMaterial(password, answer);
  w.secret(material.derivedKey);
  if (material.upgrade) w.secret(material.upgrade.derivedKey);
  const upgraded = material.upgrade !== undefined;
  const reply = await w.step({
    who: actor,
    say: upgraded
      ? 'submits the login form with the migrated Rails password (the browser recomputes the bcrypt hash and sends an Argon2id upgrade with it)'
      : `submits the login form${options.deviceSession ? ' and ticks "remember this device"' : ''}`,
    method: 'POST',
    path: '/v2/auth/login',
    json: {
      identifier,
      ...(options.communitySlug
        ? { communitySlug: options.communitySlug }
        : {}),
      derivedKey: material.derivedKey,
      ...(material.upgrade ? { upgrade: material.upgrade } : {}),
      ...(options.deviceSession ? { deviceSession: true } : {}),
    },
    expect: 200,
    covers: ['A06', ...(options.covers ?? [])],
    show: (r) => [
      field(
        'signed in as',
        val(r, 'user', 'displayName') ?? val(r, 'user', 'username')
      ),
      field('role', val(r, 'user', 'role')),
      'the session cookie is set (HttpOnly; its value is never shown here)',
    ],
  });
  actor.identifier = identifier;
  actor.password = password;
  actor.userId = num(reply, 'user', 'id');
  return { upgraded, reply };
}

/** Run one cleanup task; a failure is recorded and the next task still runs. */
export async function attempt(
  ctx: Ctx,
  name: string,
  body: () => Promise<void>
): Promise<void> {
  try {
    await body();
  } catch (error) {
    ctx.w.failed = true;
    ctx.w.narrate(
      `Cleanup task "${name}" failed: ${error instanceof Error ? error.message : String(error)}`
    );
    ctx.s.notes.push(`cleanup ${name}: failed`);
  }
}

/** Run a chapter body; a failed step ends the chapter but not the run. */
export async function guarded(
  ctx: Ctx,
  name: string,
  body: () => Promise<void>
): Promise<void> {
  try {
    await body();
  } catch (error) {
    ctx.w.failed = true;
    ctx.w.narrate(
      `Chapter stopped: ${error instanceof Error ? error.message : String(error)}`
    );
    ctx.s.notes.push(`${name}: stopped early`);
  }
}

/**
 * A person with a one-time login code opens the "I have a code" page, picks
 * a password (stretched in the browser) and is signed in.
 */
export async function activate(
  ctx: Ctx,
  actor: Actor,
  account: Account,
  covers: string[] = []
): Promise<Reply> {
  const { w } = ctx;
  if (!account.loginCode) throw new Error(`no login code for ${account.key}`);
  const password = randomPassword();
  w.secret(password);
  const verifier = await newVerifier(password);
  w.secret(verifier.derivedKey);
  const reply = await w.step({
    who: actor,
    say: `opens the "I have a code" page, pastes the one-time code and chooses a password`,
    method: 'POST',
    path: '/v2/auth/recovery/redeem',
    json: {
      code: account.loginCode,
      identifier: account.username,
      password: verifier,
    },
    expect: 200,
    covers: ['V09', ...covers],
    show: (r) => [
      field('signed in as', val(r, 'user', 'displayName')),
      field('role', val(r, 'user', 'role')),
      'the code is now spent; the password was stretched in the browser and never sent',
    ],
  });
  account.password = password;
  account.loginCode = undefined;
  actor.identifier = account.username;
  actor.password = password;
  actor.userId = num(reply, 'user', 'id');
  return reply;
}

/** Upload a file to private staging; returns the file id. */
export async function upload(
  ctx: Ctx,
  actor: Actor,
  say: string,
  file: { name: string; type: string; bytes: Uint8Array },
  covers: string[]
): Promise<string> {
  const { rawUpload } = await import('./client.js');
  const reply = await ctx.w.step({
    who: actor,
    say,
    method: 'POST',
    path: '/v2/media',
    ...rawUpload({}, file),
    bodyNote: `raw body, one file (${file.type}) with x-content-sha256`,
    expect: 201,
    covers,
    show: (r) => [
      field('file', val(r, 'data', 'originalName')),
      field('type', val(r, 'data', 'mimeType')),
      field('size (bytes)', val(r, 'data', 'byteSize')),
      'private staging file: not visible to anyone until it is attached',
    ],
  });
  const id = str(reply, 'data', 'id');
  ctx.s.uploaded.push(id);
  return id;
}

export async function attach(
  ctx: Ctx,
  actor: Actor,
  say: string,
  body: {
    fileId: string;
    ownerType: string;
    ownerId: number;
    role: string;
    ordinal?: number;
  },
  covers: string[]
): Promise<number> {
  const reply = await ctx.w.step({
    who: actor,
    say,
    method: 'POST',
    path: '/v2/attachments',
    json: body,
    expect: 201,
    covers,
    show: (r) => [
      field('role', val(r, 'data', 'role')),
      field('position', val(r, 'data', 'ordinal')),
    ],
  });
  return num(reply, 'data', 'id');
}
