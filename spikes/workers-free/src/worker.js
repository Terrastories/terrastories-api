// Workers Free feasibility spike for issue #194. Not part of the application.
// Each route does exactly one unit of work so per-invocation CPU time maps to it.
import bcrypt from 'bcryptjs';
import Argon2 from '@phi-ag/argon2';
import argon2Wasm from '@phi-ag/argon2/argon2.wasm';
import { BCRYPT, PASSWORD } from './fixtures.js';
import { login, session } from './auth.js';

export { CpuProbe } from './probe-do.js';

const enc = new TextEncoder();
// Throwaway 256-bit token made on first use (random values are not allowed in global
// scope); its digest stands in for a stored session row.
let tokenState;
async function storedToken() {
  if (!tokenState) {
    const token = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))
    )
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    tokenState = {
      token,
      digest: await crypto.subtle.digest('SHA-256', enc.encode(token)),
    };
  }
  return tokenState;
}

async function pbkdf2(iterations) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(PASSWORD),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return bits.byteLength === 32;
}

function int(url, name, fallback) {
  const v = Number(url.searchParams.get(name) ?? fallback);
  if (!Number.isInteger(v) || v < 1) throw new Error(`bad ${name}`);
  return v;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/noop':
          return Response.json({ ok: true });
        case '/bcrypt': {
          const cost = url.searchParams.get('cost');
          const hash = BCRYPT[cost];
          if (!hash) return new Response('unknown cost', { status: 400 });
          // Rails login path: verify a preserved $2a$ hash.
          const ok = bcrypt.compareSync(PASSWORD, hash);
          return Response.json({ ok, cost: Number(cost) });
        }
        case '/auth/login':
          if (request.method !== 'POST')
            return new Response('method', { status: 405 });
          return await login(request, env);
        case '/auth/session':
          return await session(request, env);
        case '/do/bcrypt': {
          // A fresh object per request, so each one starts with no prior CPU history.
          const stub = env.PROBE.get(env.PROBE.newUniqueId());
          return await stub.fetch(request);
        }
        case '/sha256': {
          // Baseline: verify a high-entropy token (256-bit, base64url) against a stored
          // SHA-256 digest, as a session or claim-token lookup would.
          const stored = await storedToken();
          const presented = url.searchParams.get('token') ?? stored.token;
          const digest = await crypto.subtle.digest(
            'SHA-256',
            enc.encode(presented)
          );
          const ok = crypto.subtle.timingSafeEqual(digest, stored.digest);
          return Response.json({ ok });
        }
        case '/pbkdf2': {
          const iterations = int(url, 'iter', 100000);
          return Response.json({ ok: await pbkdf2(iterations), iterations });
        }
        case '/argon2id': {
          // Fresh instance per request: a reused instance failed with "Memory allocation
          // error" after parameter changes in the first run.
          const argon2 = new Argon2(await WebAssembly.instantiate(argon2Wasm));
          const memoryCost = int(url, 'm', 19456);
          const timeCost = int(url, 't', 2);
          const parallelism = int(url, 'p', 1);
          // Hash cost equals verify cost for Argon2id; hashing avoids a fixture per parameter set.
          const { encoded } = argon2.hash(PASSWORD, {
            memoryCost,
            timeCost,
            parallelism,
          });
          return Response.json({
            ok: encoded.startsWith('$argon2id$'),
            memoryCost,
            timeCost,
          });
        }
        case '/d1/count': {
          const row = await env.DB.prepare(
            'SELECT (SELECT COUNT(*) FROM stories) AS stories, (SELECT COUNT(*) FROM places) AS places'
          ).first();
          return Response.json(row);
        }
        case '/d1/batch': {
          // In-Worker import path: one invocation, one batch of `stmts` INSERT statements,
          // each inserting `rows` rows (3 bound params per row; D1 allows 100 per statement).
          const stmts = int(url, 'stmts', 10);
          const rows = int(url, 'rows', 25);
          const run = crypto.randomUUID();
          const sql = `INSERT INTO spike_import (run, n, body) VALUES ${Array(rows).fill('(?,?,?)').join(',')}`;
          const batch = [];
          for (let i = 0; i < stmts; i++) {
            const params = [];
            for (let r = 0; r < rows; r++)
              params.push(run, i * rows + r, 'x'.repeat(200));
            batch.push(env.DB.prepare(sql).bind(...params));
          }
          const res = await env.DB.batch(batch);
          const written = res.reduce(
            (a, r) => a + (r.meta?.rows_written ?? 0),
            0
          );
          return Response.json({ ok: true, stmts, rows, rowsWritten: written });
        }
        case '/r2/put': {
          const key = `spike/${crypto.randomUUID()}`;
          // PUT streams the client's request body to R2 (the upload path); GET writes a
          // generated buffer of `kb` KiB.
          const upload = request.method === 'PUT';
          const size = upload
            ? Number(request.headers.get('content-length'))
            : int(url, 'kb', 512) * 1024;
          await env.MEDIA.put(
            key,
            upload ? request.body : new Uint8Array(size),
            {
              httpMetadata: { contentType: 'application/octet-stream' },
            }
          );
          return Response.json({ ok: true, key, size });
        }
        case '/r2/get': {
          // Protected read: the real app authorizes first; here we only stream the object.
          const obj = await env.MEDIA.get(url.searchParams.get('key') ?? '');
          if (!obj) return new Response('not found', { status: 404 });
          return new Response(obj.body, {
            headers: {
              'content-type': 'application/octet-stream',
              'cache-control': 'private',
            },
          });
        }
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (err) {
      return Response.json(
        { ok: false, error: String(err?.message ?? err) },
        { status: 500 }
      );
    }
  },
};
