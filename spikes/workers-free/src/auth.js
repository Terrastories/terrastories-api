// Client-stretching login protocol from the Fable 5.2 auth design (#184), server half only.
// The client sends an already-stretched derivedKey; the Worker does one D1 read, SHA-256,
// a constant-time compare and one D1 write. Every response reports D1 rows written.
const enc = new TextEncoder();
const MAX_FAILURES = 5;
const BACKOFF_BASE_S = 2;
const SESSION_TTL_S = 12 * 3600;

function b64urlDecode(s) {
  const bin = atob(s.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64urlEncode(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
const sha256 = async (bytes) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const DUMMY_HASH = new Uint8Array(32);

function reply(status, body, rowsWritten, extraHeaders = {}) {
  return Response.json(
    { ...body, rowsWritten },
    {
      status,
      headers: { 'x-spike-rows-written': String(rowsWritten), ...extraHeaders },
    }
  );
}

export async function login(request, env) {
  const { communityId, identifier, derivedKey } = await request.json();
  const now = Math.floor(Date.now() / 1000);
  // One read: account, its stored key hash and its throttle row.
  const user = await env.DB.prepare(
    `SELECT u.id, u.key_hash, u.disabled, t.failures, t.last_failed_at
       FROM auth_users u LEFT JOIN auth_throttle t ON t.key = 'u:' || u.id
      WHERE u.community_id = ? AND u.identifier = ?`
  )
    .bind(communityId, identifier)
    .first();
  if (user?.failures >= MAX_FAILURES) {
    const wait =
      BACKOFF_BASE_S ** Math.min(user.failures - MAX_FAILURES + 1, 10);
    if (now - user.last_failed_at < wait)
      return reply(429, { ok: false, retryAfter: wait }, 0);
  }
  const presented = await sha256(b64urlDecode(derivedKey));
  const stored = user ? new Uint8Array(user.key_hash) : DUMMY_HASH;
  const match =
    crypto.subtle.timingSafeEqual(presented, stored) && user && !user.disabled;
  if (!match) {
    // Exactly one write per failed login: upsert the per-account counter (unknown
    // identifiers get a counter keyed by the identifier, so they cost the same).
    const key = user ? `u:${user.id}` : `i:${communityId}:${identifier}`;
    const res = await env.DB.prepare(
      `INSERT INTO auth_throttle (key, failures, last_failed_at) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET failures = failures + 1, last_failed_at = excluded.last_failed_at`
    )
      .bind(key, now)
      .run();
    return reply(401, { ok: false }, res.meta.rows_written);
  }
  const token = crypto.getRandomValues(new Uint8Array(32));
  const stmts = [
    env.DB.prepare(
      'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).bind(await sha256(token), user.id, now, now + SESSION_TTL_S),
  ];
  // Clearing a non-empty throttle row is the only extra write, and only after failures.
  if (user.failures)
    stmts.push(
      env.DB.prepare('DELETE FROM auth_throttle WHERE key = ?').bind(
        `u:${user.id}`
      )
    );
  const res = await env.DB.batch(stmts);
  const written = res.reduce((a, r) => a + r.meta.rows_written, 0);
  return reply(200, { ok: true, token: b64urlEncode(token) }, written, {
    'set-cookie': `ts_session=${b64urlEncode(token)}; HttpOnly; Secure; SameSite=Lax; Path=/`,
  });
}

export async function session(request, env) {
  const cookie = request.headers.get('cookie') ?? '';
  const token = /(?:^|;\s*)ts_session=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1];
  if (!token) return reply(401, { ok: false }, 0);
  // The user is re-read on every request so disable/role changes apply immediately.
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, s.revoked_at, u.disabled, u.community_id
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ?`
  )
    .bind(await sha256(b64urlDecode(token)))
    .first();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.revoked_at || row.disabled || row.expires_at <= now)
    return reply(401, { ok: false }, 0);
  return reply(
    200,
    { ok: true, userId: row.user_id, communityId: row.community_id },
    0
  );
}

export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_users (id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL, identifier TEXT NOT NULL, key_hash BLOB NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, UNIQUE (community_id, identifier));
CREATE TABLE IF NOT EXISTS auth_sessions (token_hash BLOB PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS auth_throttle (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, last_failed_at INTEGER NOT NULL) WITHOUT ROWID;
`;
