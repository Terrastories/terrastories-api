/**
 * Micro-benchmark for #295 (Workers Free 10 ms CPU budget). Not run in CI.
 *
 *   npx tsx scripts/perf/protected-request.bench.ts
 *
 * Measures, on an in-memory SQLite database:
 *  - protected-request lookups: BEFORE (session read + erasurePending +
 *    hasActiveRecoveryCodes, three queries) vs AFTER (one joined query);
 *  - description sanitiser on plain text: full parse pipeline vs fast path.
 * SQLite is synchronous, so absolute numbers understate D1 round-trip savings;
 * they show query-construction/decode CPU only, which is what counts on Workers.
 */
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import { HonoFoundationService } from '../../src/services/hono-foundation.service.js';
import { communitiesSqlite } from '../../src/db/schema/communities.js';
import { usersSqlite } from '../../src/db/schema/users.js';
import {
  descriptionPlainText,
  runSanitiser,
  validateDescriptionForWrite,
} from '../../src/shared/utils/safe-description.js';
import {
  argon2Seed,
  makeDerivedKey,
} from '../../tests/hono/auth-test-utils.js';
import { sessionLifetime } from '../../src/shared/session-policy.js';

const ITER = Number(process.env.BENCH_ITER ?? 3000);

async function time(label: string, fn: () => Promise<unknown> | unknown) {
  for (let i = 0; i < 200; i++) await fn(); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) await fn();
  const per = ((performance.now() - t0) / ITER) * 1000;
  console.log(label.padEnd(46), per.toFixed(1).padStart(9), 'us/op');
  return per;
}

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
migrate(db, { migrationsFolder: 'src/db/migrations' });
const [community] = await db
  .insert(communitiesSqlite)
  .values({ name: 'Bench', slug: 'bench', publicStories: true, isActive: true })
  .returning();
const seed = await argon2Seed(makeDerivedKey());
const [user] = await db
  .insert(usersSqlite)
  .values({
    email: 'bench@example.test',
    username: 'bench',
    displayName: 'Bench',
    ...seed,
    passwordHash: 'x',
    firstName: 'B',
    lastName: 'B',
    role: 'admin',
    communityId: community!.id,
    isActive: true,
  } as never)
  .returning();
const repository = new HonoFoundationRepository(db as never);
const sovereignty = new CommunitySovereigntyRepository(db as never);
const service = new HonoFoundationService(repository, {} as never);
const now = new Date();
const token = 'a'.repeat(64);
const { tokenDigest } = await import(
  '../../src/services/hono-foundation.service.js'
);
const tokenHash = await tokenDigest(token);
await repository.createSession({
  tokenHash,
  user: user as never,
  kind: 'standard',
  createdAt: now,
  idleExpiresAt: new Date(now.getTime() + sessionLifetime),
  absoluteExpiresAt: new Date(now.getTime() + sessionLifetime),
});

console.log('iterations:', ITER);
const before = await time('protected lookups BEFORE (3 queries)', async () => {
  const s = await service.actor(token, now, false);
  if (!s) throw new Error('no session');
  await sovereignty.erasurePending(s.user.communityId!);
  await repository.hasActiveRecoveryCodes(s.user.id);
});
const after = await time(
  'protected lookups AFTER (1 joined query)',
  async () => {
    const s = await service.actor(token, now, true);
    if (!s?.gates) throw new Error('no session');
  }
);
console.log('speedup', (before / after).toFixed(2) + 'x');

const plain = 'Uma historia curta sobre o rio, a aldeia e as pessoas. '.repeat(
  20
);
const short = 'A short plain description.';
for (const [name, text] of [
  ['short (26 chars)', short],
  ['plain ~1.1 KB', plain],
] as const) {
  const full = await time(`sanitizer FULL  ${name}`, () =>
    descriptionPlainText(runSanitiser(text, 'runtime', false).html)
  );
  const fast = await time(`sanitizer FAST  ${name}`, () =>
    validateDescriptionForWrite(text)
  );
  console.log('speedup', (full / fast).toFixed(2) + 'x');
}
sqlite.close();
