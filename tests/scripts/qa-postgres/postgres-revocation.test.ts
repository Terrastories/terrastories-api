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
            });
            expect(
              await live(),
              `iteration ${i} (claim ${claimResponse.status})`
            ).toEqual({ sessions: 0, codes: 0 });
          }
          // After every race: nothing created by a claim survives the revocation
          // that completed after it, and nothing usable remains.
          const n = async (query: Promise<Array<{ n: number | string }>>) =>
            Number((await query)[0]?.n ?? 0);
          // The last iteration's revocation ran after or before its claim; one
          // final revocation (the operator's verification run) must leave zero.
          await revokeAllSessions(revokeDb);
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

    it.skipIf(!decision.run).each(['login', 'claim'] as const)(
      'deterministic: revocation waits for an in-flight %s-style transaction and then deletes its session',
      async (shape) => {
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
          const [community] = await revokeDb
            .insert(communitiesPg)
            .values({ name: 'det', slug: 'det', isActive: true })
            .returning();
          const createdAt = Date.now();
          const [token] = await revokeDb
            .insert(claimTokensPg)
            .values({
              communityId: community!.id,
              tokenHash: 'a'.repeat(64),
              createdAt,
              expiresAt: createdAt + 3_600_000,
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

          let release!: () => void;
          const hold = new Promise<void>((resolve) => (release = resolve));
          let inserted!: () => void;
          const insertedSession = new Promise<void>(
            (resolve) => (inserted = resolve)
          );
          // An in-flight session creator that stays open: a plain login, or the
          // claim's shape (lock the token row, consume it, insert the session).
          const claimTx = claimClient.begin(async (tx) => {
            if (shape === 'claim') {
              await tx`select id from claim_tokens where id = ${token!.id} for update`;
              await tx`update claim_tokens set consumed_at = ${createdAt}, consumed_by = ${user!.id} where id = ${token!.id}`;
            }
            await tx`insert into sessions (id, token_hash, user_id, expires_at) values ('det-session', 'det-session', ${user!.id}, ${createdAt + 3_600_000})`;
            inserted();
            await hold;
          });
          await insertedSession;
          let settled = false;
          const revocation = revokeAllSessions(revokeDb).finally(() => {
            settled = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
          // Without the table locks the revocation would finish now, not see
          // the uncommitted session, and the session would survive it.
          if (settled) release(); // do not leave the transaction open on failure
          expect(settled).toBe(false);
          release();
          await claimTx;
          const result = await revocation;
          expect(result.revoked).toBe(1);
          expect(
            Number(
              (await revokeDb.select({ n: count() }).from(sessionsPg))[0]?.n ??
                0
            )
          ).toBe(0);
        } finally {
          await Promise.allSettled([revokeClient.end(), claimClient.end()]);
        }
      },
      60_000
    );
  }
);
