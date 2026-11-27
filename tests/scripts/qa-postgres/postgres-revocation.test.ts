/**
 * PostgreSQL two-connection regression for the emergency global revocation
 * (#137): a real bootstrap claim (POST /v2/bootstrap/claim) racing the
 * revocation must neither deadlock nor leave a session, a claim token or a
 * login code usable. Runs only in the dedicated PostgreSQL gate
 * (npm run qa:personas:postgres); skipped elsewhere.
 */
import { join } from 'node:path';
import { and, count, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { describe, expect, it } from 'vitest';
import { decidePostgresPersonaQa } from '../../../scripts/qa/qa-database.js';
import { createPostgresClient } from '../../../src/db/index.js';
import { createHonoApp } from '../../../src/hono-app.js';
import { HonoFoundationRepository } from '../../../src/repositories/hono-foundation.repository.js';
import { revokeAllSessions } from '../../../src/ops/revoke-all-sessions.js';
import { communitiesPg } from '../../../src/db/schema/communities.js';
import { sessionsPg } from '../../../src/db/schema/sessions.js';
import { usersPg } from '../../../src/db/schema/users.js';
import {
  claimTokensPg,
  loginCodesPg,
} from '../../../src/db/schema/login_codes.js';
import {
  ARGON2ID_ALGORITHM,
  ARGON2ID_PARAMS,
} from '../../../src/shared/auth-policy.js';
import { sha256Hex, toBase64Url } from '../../../src/shared/auth-crypto.js';
import {
  argon2Seed,
  makeDerivedKey,
  makeVerifierSalt,
} from '../../hono/auth-test-utils.js';

const decision = decidePostgresPersonaQa(
  process.env.QA_PERSONAS_POSTGRES,
  process.env.QA_POSTGRES_URL,
  process.env.ALLOW_POSTGRES_TEST_RESET
);

const ORIGIN = 'https://api.example.test';
const ITERATIONS = 30;

describe(
  decision.run
    ? 'Global revocation vs bootstrap claim (PostgreSQL)'
    : `Global revocation vs bootstrap claim (PostgreSQL) — skipped: ${decision.reason}`,
  () => {
    it.skipIf(!decision.run)(
      'a claim racing the revocation neither deadlocks nor survives it',
      async () => {
        if (decision.target.status !== 'ready')
          throw new Error(
            `requires a PostgreSQL target: ${decision.target.reason}`
          );
        const url = decision.target.url;
        const revokeClient = createPostgresClient(url, { max: 2 });
        const claimClient = createPostgresClient(url, {
          max: 2,
          onnotice: () => undefined,
        });
        try {
          await revokeClient.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
          await revokeClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
          await revokeClient.unsafe('CREATE SCHEMA public');
          const revokeDb = drizzle(revokeClient);
          await migrate(revokeDb, {
            migrationsFolder: join(process.cwd(), 'src/db/migrations/postgres'),
          });
          const claimDb = drizzle(claimClient);
          const app = createHonoApp({
            repository: new HonoFoundationRepository(claimDb as never),
            storage: { read: async () => null },
            serverSecret: makeDerivedKey(),
            secureCookies: false,
            publicOrigin: ORIGIN,
            trustProxy: true,
            isWorkers: true,
          });

          const statuses: number[] = [];
          for (let i = 0; i < ITERATIONS; i += 1) {
            const [community] = await revokeDb
              .insert(communitiesPg)
              .values({ name: `race-${i}`, slug: `race-${i}`, isActive: true })
              .returning();
            const raw = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
            const createdAt = Date.now();
            await revokeDb.insert(claimTokensPg).values({
              communityId: community!.id,
              tokenHash: await sha256Hex(raw),
              createdAt,
              expiresAt: createdAt + 3_600_000,
            });
            const claim = () =>
              app.request(`${ORIGIN}/v2/bootstrap/claim`, {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'cf-connecting-ip': `203.0.113.${(i % 200) + 1}`,
                },
                body: JSON.stringify({
                  token: raw,
                  username: `racer_${i}`,
                  email: `racer${i}@race.example.test`,
                  password: {
                    algorithm: ARGON2ID_ALGORITHM,
                    salt: makeVerifierSalt(),
                    params: { ...ARGON2ID_PARAMS },
                    derivedKey: makeDerivedKey(),
                  },
                }),
              });
            const pause = (ms: number) =>
              new Promise((resolve) => setTimeout(resolve, ms));
            // The claim does request parsing and lookups before its transaction,
            // so sweep the revocation start from 0 to ~140 ms after the claim
            // to land it before, inside and after the claim's transaction.
            const claimDelay = 0;
            const revokeDelay = i * 5;
            const [claimResponse, revoked] = await Promise.all([
              pause(claimDelay).then(claim),
              pause(revokeDelay).then(() => revokeAllSessions(revokeDb)),
            ]);
            // No deadlock abort and no server error on either side.
            expect(revoked.runId).toBeTruthy();
            expect([201, 400, 401, 404, 409]).toContain(claimResponse.status);
            statuses.push(claimResponse.status);
            // A claim that succeeded must have committed before the revocation
            // (a claim after it fails on its superseded token), so right now no
            // session, usable code or usable token may exist.
            const live = async () => ({
              sessions: Number(
                (await revokeDb.select({ n: count() }).from(sessionsPg))[0]
                  ?.n ?? 0
              ),
              codes: Number(
                (
                  await revokeDb
                    .select({ n: count() })
                    .from(loginCodesPg)
                    .where(
                      and(
                        isNull(loginCodesPg.usedAt),
                        isNull(loginCodesPg.supersededAt)
                      )
                    )
                )[0]?.n ?? 0
              ),
              tokens: Number(
                (
                  await revokeDb
                    .select({ n: count() })
                    .from(claimTokensPg)
                    .where(
                      and(
                        isNull(claimTokensPg.consumedAt),
                        isNull(claimTokensPg.supersededAt)
                      )
                    )
                )[0]?.n ?? 0
              ),
            });
            expect(
              await live(),
              `iteration ${i} (claim ${claimResponse.status})`
            ).toEqual({ sessions: 0, codes: 0, tokens: 0 });
          }
          // After every race: nothing created by a claim survives the revocation
          // that completed after it, and nothing usable remains.
          const n = async (query: Promise<Array<{ n: number | string }>>) =>
            Number((await query)[0]?.n ?? 0);
          // Each pair was already asserted clean above; the end state needs no
          // extra revocation.
          expect(
            await n(revokeDb.select({ n: count() }).from(sessionsPg))
          ).toBe(0);
          expect(
            await n(
              revokeDb
                .select({ n: count() })
                .from(loginCodesPg)
                .where(
                  and(
                    isNull(loginCodesPg.usedAt),
                    isNull(loginCodesPg.supersededAt)
                  )
                )
            )
          ).toBe(0);
          expect(
            await n(
              revokeDb
                .select({ n: count() })
                .from(claimTokensPg)
                .where(
                  and(
                    isNull(claimTokensPg.consumedAt),
                    isNull(claimTokensPg.supersededAt)
                  )
                )
            )
          ).toBe(0);
          // The races really interleaved: some claims won, some lost.
          expect(statuses.length).toBe(ITERATIONS);
          expect(statuses).toContain(201);
          expect(statuses.some((status) => status !== 201)).toBe(true);
        } finally {
          await Promise.allSettled([revokeClient.end(), claimClient.end()]);
        }
      },
      120_000
    );

    // Shared setup for the deterministic tests below.
    const withFreshDb = async <T>(
      body: (ctx: {
        revokeDb: ReturnType<typeof drizzle>;
        claimClient: ReturnType<typeof createPostgresClient>;
        revokeClient: ReturnType<typeof createPostgresClient>;
        communityId: number;
        tokenId: number;
        userId: number;
        now: number;
      }) => Promise<T>
    ): Promise<T> => {
      if (decision.target.status !== 'ready')
        throw new Error(
          `requires a PostgreSQL target: ${decision.target.reason}`
        );
      const url = decision.target.url;
      // Deterministic deadlock victim: the connection whose deadlock_timeout
      // is shorter runs the detector first and aborts itself. The revocation
      // detects after 300 ms; the other side would only after 30 s. (These
      // settings need a superuser, which the dedicated test database user is.)
      const revokeClient = createPostgresClient(url, {
        max: 2,
        connection: { deadlock_timeout: '300ms' },
      });
      const claimClient = createPostgresClient(url, {
        max: 2,
        onnotice: () => undefined,
        connection: { deadlock_timeout: '30s' },
      });
      try {
        await revokeClient.unsafe('DROP SCHEMA IF EXISTS drizzle CASCADE');
        await revokeClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
        await revokeClient.unsafe('CREATE SCHEMA public');
        const revokeDb = drizzle(revokeClient);
        await migrate(revokeDb, {
          migrationsFolder: join(process.cwd(), 'src/db/migrations/postgres'),
        });
        const [community] = await revokeDb
          .insert(communitiesPg)
          .values({ name: 'det', slug: 'det', isActive: true })
          .returning();
        const now = Date.now();
        const [token] = await revokeDb
          .insert(claimTokensPg)
          .values({
            communityId: community!.id,
            tokenHash: 'a'.repeat(64),
            createdAt: now,
            expiresAt: now + 3_600_000,
          })
          .returning();
        const [user] = await revokeDb
          .insert(usersPg)
          .values({
            ...(await argon2Seed(makeDerivedKey())),
            passwordHash: 'legacy-hash',
            firstName: 'Det',
            lastName: 'User',
            isActive: true,
            role: 'admin',
            email: 'det@race.example.test',
            emailNormalized: 'det@race.example.test',
            username: 'det_user',
            usernameNormalized: 'det_user',
            communityId: community!.id,
          })
          .returning();
        return await body({
          revokeDb,
          claimClient,
          revokeClient,
          communityId: community!.id,
          tokenId: token!.id,
          userId: user!.id,
          now,
        });
      } finally {
        await Promise.allSettled([revokeClient.end(), claimClient.end()]);
      }
    };

    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    // Poll pg_stat_activity until some other backend is blocked on a lock.
    const waitForLockWait = async (
      client: ReturnType<typeof createPostgresClient>,
      query: RegExp
    ) => {
      for (let i = 0; i < 100; i += 1) {
        const rows = await client`
          select query from pg_stat_activity
          where wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
        if (rows.some((row) => query.test(String(row.query)))) return;
        await sleep(50);
      }
      throw new Error('revocation never started waiting on a lock');
    };

    /** A gate a parked transaction waits on; always released in `finally`. */
    const gate = () => {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      return { promise, open };
    };
    const countSessions = async (db: ReturnType<typeof drizzle>) =>
      Number((await db.select({ n: count() }).from(sessionsPg))[0]?.n ?? 0);

    it.skipIf(!decision.run)(
      'deterministic claim interleaving: revocation starts while the claim holds the token lock, before its session insert — no deadlock, no retry, no survivor',
      async () => {
        await withFreshDb(
          async ({
            revokeDb,
            claimClient,
            revokeClient,
            tokenId,
            userId,
            now,
          }) => {
            const proceed = gate();
            let locked!: () => void;
            const tokenLocked = new Promise<void>(
              (resolve) => (locked = resolve)
            );
            const pending: Array<Promise<unknown>> = [];
            try {
              // The claim's transaction shape up to the point the real one is
              // at when revocation arrives: token row locked and consumed, the
              // session NOT yet inserted.
              const claimTx = claimClient.begin(async (tx) => {
                await tx`select id from claim_tokens where id = ${tokenId} for update`;
                await tx`update claim_tokens set consumed_at = ${now}, consumed_by = ${userId} where id = ${tokenId}`;
                locked();
                await proceed.promise;
                await tx`insert into sessions (id, token_hash, user_id, expires_at) values ('det-session', 'det-session', ${userId}, ${now + 3_600_000})`;
              });
              pending.push(claimTx);
              await tokenLocked;
              let settled = false;
              const revocation = revokeAllSessions(revokeDb).finally(() => {
                settled = true;
              });
              pending.push(revocation);
              // Wait until revocation is really blocked (it needs the
              // claim_tokens lock the claim holds), then let the claim go on
              // to insert its session.
              await waitForLockWait(revokeClient, /LOCK TABLE|claim_tokens/i);
              expect(settled).toBe(false);
              proceed.open();
              // With the old order (sessions locked first) the claim's insert
              // and the revocation's claim_tokens lock deadlock here.
              await claimTx;
              const result = await revocation;
              expect(result.attempts).toBe(1);
              expect(result.revoked).toBe(1);
              expect(await countSessions(revokeDb)).toBe(0);
            } finally {
              proceed.open();
              await Promise.allSettled(pending);
            }
          }
        );
      },
      60_000
    );

    it.skipIf(!decision.run)(
      'deterministic login interleaving: revocation waits for an in-flight session insert and then deletes it',
      async () => {
        await withFreshDb(async ({ revokeDb, claimClient, userId, now }) => {
          const hold = gate();
          let inserted!: () => void;
          const insertedSession = new Promise<void>(
            (resolve) => (inserted = resolve)
          );
          const pending: Array<Promise<unknown>> = [];
          try {
            const loginTx = claimClient.begin(async (tx) => {
              await tx`insert into sessions (id, token_hash, user_id, expires_at) values ('det-login', 'det-login', ${userId}, ${now + 3_600_000})`;
              inserted();
              await hold.promise;
            });
            pending.push(loginTx);
            await insertedSession;
            let settled = false;
            const revocation = revokeAllSessions(revokeDb).finally(() => {
              settled = true;
            });
            pending.push(revocation);
            await sleep(500);
            expect(settled).toBe(false);
            hold.open();
            await loginTx;
            expect((await revocation).revoked).toBe(1);
            expect(await countSessions(revokeDb)).toBe(0);
          } finally {
            hold.open();
            await Promise.allSettled(pending);
          }
        });
      },
      60_000
    );

    it.skipIf(!decision.run)(
      'retries after a (synthetic) real deadlock: the SQLSTATE is read through the Drizzle error wrapper',
      async () => {
        await withFreshDb(
          async ({
            revokeDb,
            claimClient,
            revokeClient,
            tokenId,
            userId,
            now,
          }) => {
            await revokeDb.insert(sessionsPg).values({
              id: 'dl',
              tokenHash: 'dl',
              userId,
              expiresAt: now + 3_600_000,
            });
            const proceed = gate();
            let ready!: () => void;
            const holding = new Promise<void>((resolve) => (ready = resolve));
            const pending: Array<Promise<unknown>> = [];
            try {
              // A synthetic transaction that holds a session row lock and then
              // needs a claim_tokens row: the inverse of the revocation's
              // table-lock order, built only to force a real 40P01 (no
              // production path does this).
              const other = claimClient.begin(async (tx) => {
                await tx`select id from sessions where id = 'dl' for update`;
                ready();
                await proceed.promise;
                await tx`update claim_tokens set superseded_at = ${now} where id = ${tokenId}`;
              });
              pending.push(other);
              await holding;
              // Revocation holds claim_tokens and waits for the sessions lock.
              const revocation = revokeAllSessions(revokeDb);
              pending.push(revocation);
              await waitForLockWait(revokeClient, /LOCK TABLE/i);
              // Now the other side asks for claim_tokens and the cycle closes.
              // The revocation connection's deadlock_timeout (300 ms) is far
              // shorter than the other's (30 s), so the revocation is the
              // victim every time; it then retries.
              proceed.open();
              const result = await revocation;
              expect(result.attempts).toBeGreaterThanOrEqual(2);
              // The synthetic side must have completed (it was not the victim).
              await other; // rejects if the synthetic side was the victim
              expect(await countSessions(revokeDb)).toBe(0);
            } finally {
              proceed.open();
              await Promise.allSettled(pending);
            }
          }
        );
      },
      60_000
    );
  }
);
