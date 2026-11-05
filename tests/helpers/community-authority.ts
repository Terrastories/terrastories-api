/**
 * Test helpers for SPEC-V2 §7 community authority.
 *
 * `POST /api/v1/auth/register` needs a same-community administrator session
 * (anonymous callers get 401), and system administrators may not mint
 * community accounts. Tests that only need fixture accounts insert them
 * directly with `seedRegisteredUser`; tests whose subject is enrollment call
 * the route with `communityAdminCookie`.
 */
import type { FastifyInstance } from 'fastify';
import { usersSqlite } from '../../src/db/schema/index.js';
import { hashPassword } from '../../src/services/password.service.js';
import type { TestDatabase } from './database.js';
import { extractSignedSessionCookie } from './session-cookie.js';

export interface RegisteredUserFixture {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  communityId: number;
  isActive?: boolean;
}

/**
 * Insert a login-able account the way registration would have stored it.
 * Returns the stored row.
 */
export async function seedRegisteredUser(
  db: TestDatabase,
  user: RegisteredUserFixture
) {
  const [row] = await db
    .insert(usersSqlite)
    .values({
      email: user.email,
      passwordHash: await hashPassword(user.password),
      firstName: user.firstName ?? 'Test',
      lastName: user.lastName ?? 'User',
      role: (user.role ?? 'viewer') as 'viewer',
      communityId: user.communityId,
      isActive: user.isActive ?? true,
    })
    .returning();
  return row;
}

let adminSequence = 0;

/**
 * Seed a community administrator in `communityId` and return a signed
 * session cookie for it, for tests that exercise enrollment through
 * `POST /api/v1/auth/register`.
 */
export async function communityAdminCookie(
  app: FastifyInstance,
  db: TestDatabase,
  communityId: number
): Promise<string> {
  adminSequence += 1;
  const email = `community-authority-${communityId}-${Date.now()}-${adminSequence}@example.test`;
  const password = 'CommunityAuthority2026!Pass';
  await seedRegisteredUser(db, {
    email,
    password,
    firstName: 'Community',
    lastName: 'Authority',
    role: 'admin',
    communityId,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password, communityId },
  });
  if (login.statusCode !== 200) {
    throw new Error(
      `communityAdminCookie: login failed with ${login.statusCode}`
    );
  }
  return extractSignedSessionCookie(login.headers['set-cookie']);
}
