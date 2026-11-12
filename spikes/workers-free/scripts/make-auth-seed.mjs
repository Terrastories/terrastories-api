// Writes the auth tables and USERS synthetic accounts as SQL for `wrangler d1 execute`.
// Usage: node scripts/make-auth-seed.mjs <out.sql>
import { writeFileSync } from 'node:fs';
import { AUTH_SCHEMA } from '../src/auth.js';
import { COMMUNITY_ID, USERS, identifier, keyHash } from './auth-keys.mjs';

const rows = Array.from(
  { length: USERS },
  (_, k) =>
    `(${k + 1}, ${COMMUNITY_ID}, '${identifier(k + 1)}', X'${keyHash(k + 1).toString('hex')}', 0)`
);
const sql = `${AUTH_SCHEMA}\nINSERT INTO auth_users (id, community_id, identifier, key_hash, disabled) VALUES\n${rows.join(',\n')};\n`;
writeFileSync(process.argv[2] ?? 'auth-seed.sql', sql);
console.log(`wrote ${USERS} users`);
