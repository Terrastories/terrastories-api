/**
 * An ephemeral in-process V2 app (Node, SQLite, local file storage) for
 * running the walkthrough without a server, and for the end-to-end test.
 * It stands in for "the migrated community": a public community with a
 * Rails-wrapped bcrypt admin, plus a super_admin. All credentials are
 * generated at runtime and returned in memory only.
 */
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { serve } from '@hono/node-server';
import { eq, getTableColumns } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { createLocalStorage } from '../../src/node-storage.js';
import { createNodeErasureRecordStore } from '../../src/node-erasure-record-store.js';
import { tablesFor } from '../../src/db/dialect.js';
import { deriveUserIdentityColumns } from '../../src/shared/utils/derived-columns.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';
import { openPersonaQaDatabase } from '../qa/qa-database.js';
import {
  ARGON2ID_ALGORITHM,
  RAILS_BCRYPT_ALGORITHM,
  argonDerivedKey,
  POLICY_PARAMS,
  railsBcryptKey,
  randomPassword,
} from './kdf.js';

export interface LocalApp {
  baseUrl: string;
  community: string;
  bootstrapSecret: string;
  admin: { identifier: string; password: string };
  superAdmin: { identifier: string; password: string };
  /** Environment a CLI run would read, by variable name. */
  env: Record<string, string>;
  /**
   * Raw rows of everything that belongs to the stand-in community (the
   * community row, its users with credential columns, every table keyed by
   * communityId), as JSON text, to prove a run left it unchanged.
   */
  snapshotTarget: () => Promise<string>;
  close: () => Promise<void>;
}

export async function startLocalApp(
  options: { fresh?: boolean; withSuperAdmin?: boolean } = {}
): Promise<LocalApp> {
  const qa = await openPersonaQaDatabase();
  const db = await qa.openFresh();
  const { communities, users } = tablesFor(db);
  const slug = 'barbara';
  const admin = { identifier: 'ana-barbara', password: randomPassword() };
  const superAdmin = { identifier: 'sam-super', password: randomPassword() };

  if (!options.fresh) {
    const now = new Date();
    const [community] = await db
      .insert(communities)
      .values({
        name: 'Barbara (walkthrough stand-in)',
        description: 'Stand-in for the migrated community',
        slug,
        publicStories: true,
        locale: 'en',
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    // A migrated Rails account: bcrypt wrapped, upgraded at first login.
    const bcryptSalt = (await bcrypt.genSalt(10, 'a')).slice(7);
    const wrapped = await railsBcryptKey(admin.password, bcryptSalt, 10);
    const adminEmail = 'ana@barbara.example.test';
    await db.insert(users).values({
      email: adminEmail,
      username: admin.identifier,
      displayName: 'Ana (migrated admin)',
      ...deriveUserIdentityColumns({
        email: adminEmail,
        username: admin.identifier,
      }),
      firstName: 'Ana',
      lastName: 'Barbara',
      role: 'admin',
      communityId: community.id,
      isActive: true,
      passwordHash: wrapped,
      passwordAlgorithm: RAILS_BCRYPT_ALGORITHM,
      passwordSalt: bcryptSalt,
      passwordParams: JSON.stringify({ cost: 10 }),
      passwordVerifier: await sha256Hex(wrapped),
    });
  }
  if (options.withSuperAdmin ?? !options.fresh) {
    const salt = randomBytes(16).toString('base64');
    const key = await argonDerivedKey(superAdmin.password, salt, POLICY_PARAMS);
    const email = 'sam@system.example.test';
    await db.insert(users).values({
      email,
      username: superAdmin.identifier,
      displayName: 'Sam (super admin)',
      ...deriveUserIdentityColumns({ email, username: superAdmin.identifier }),
      firstName: 'Sam',
      lastName: 'Super',
      role: 'super_admin',
      communityId: null,
      isActive: true,
      passwordHash: await sha256Hex(key),
      passwordAlgorithm: ARGON2ID_ALGORITHM,
      passwordSalt: salt,
      passwordParams: JSON.stringify(POLICY_PARAMS),
      passwordVerifier: await sha256Hex(key),
    });
  }

  const storageDir = mkdtempSync(join(tmpdir(), 'tsapi-walk-store-'));
  const erasureDir = mkdtempSync(join(tmpdir(), 'tsapi-walk-erasure-'));
  const storage = await createLocalStorage(storageDir);
  const erasureStore = await createNodeErasureRecordStore(erasureDir);
  const bootstrapSecret = randomBytes(24).toString('hex');
  const app = createHonoApp({
    erasureStore,
    repository: new HonoFoundationRepository(db),
    secureCookies: false,
    serverSecret: randomBytes(24).toString('hex'),
    bootstrapSecret,
    storage,
    requireRecoveryCodes: true,
  });
  const server = serve({
    fetch: (request) => app.fetch(request),
    hostname: '127.0.0.1',
    port: 0,
    overrideGlobalObjects: false,
  });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not bind the local walkthrough server');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    community: slug,
    bootstrapSecret,
    admin,
    superAdmin,
    env: {
      WT_ADMIN_IDENTIFIER: admin.identifier,
      WT_ADMIN_PASSWORD: admin.password,
      WT_SUPER_IDENTIFIER: superAdmin.identifier,
      WT_SUPER_PASSWORD: superAdmin.password,
      WT_BOOTSTRAP_SECRET: bootstrapSecret,
    },
    snapshotTarget: async () => {
      const out: Record<string, unknown> = {};
      const [row] = await db
        .select()
        .from(communities)
        .where(eq(communities.slug, slug));
      if (!row) return JSON.stringify({});
      out.communities = row;
      for (const [name, table] of Object.entries(tablesFor(db))) {
        if (name === 'communities') continue;
        const cols = getTableColumns(table as never) as Record<string, never>;
        if (!('communityId' in cols)) continue;
        const rows = await db
          .select()
          .from(table as never)
          .where(eq(cols.communityId, row.id));
        out[name] = rows;
      }
      return JSON.stringify(out, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v
      );
    },
    close: async () => {
      (
        server as { closeIdleConnections?: () => void }
      ).closeIdleConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await qa.close();
    },
  };
}
