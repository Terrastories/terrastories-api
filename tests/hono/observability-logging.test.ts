/**
 * Privacy-safe observability (#143).
 *
 * Proves the structured request log carries a server-generated
 * request/correlation id, that the one redaction pass removes
 * credentials/tokens/signatures, that no raw path, query string or
 * client-supplied id reaches a log line, and that request bodies (story text)
 * and exception messages/params never appear — including a failed write whose
 * Drizzle error embeds the bound story title and body.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import { tablesFor } from '../../src/db/dialect.js';
import { parseJsonc } from '../../scripts/staging/guards.js';
import {
  createJsonLogger,
  describeError,
  parseLogLevel,
  redact,
  REDACTED,
} from '../../src/shared/observability/log.js';
import {
  CLIENT_REQUEST_ID_HEADER,
  ERROR_ID_HEADER,
  REQUEST_ID_HEADER,
  UNMATCHED_ROUTE,
  acceptClientRequestId,
  hashClientRequestId,
} from '../../src/shared/observability/request-log.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const tables = tablesFor(db);
const repository = new HonoFoundationRepository(db);
const storage = { read: async () => null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CapturedLine {
  line: string;
  level: string;
}

const capture = () => {
  const lines: CapturedLine[] = [];
  const logger = createJsonLogger({
    level: 'debug',
    sink: (line, level) => lines.push({ line, level }),
  });
  return { lines, logger };
};

const parsed = (lines: CapturedLine[]) =>
  lines.map(({ line }) => JSON.parse(line));

const requestLines = (lines: CapturedLine[]) =>
  parsed(lines).filter((entry) => entry.msg === 'http.request');

describe('central redaction (#143)', () => {
  it('removes credentials, cookies, codes, tokens, authorization and signatures', () => {
    const secrets = [
      'hunter2-password',
      'ts_session-cookie-value',
      'LOGIN-CODE-123',
      'CLAIM-TOKEN-456',
      'RECOVERY-CODE-789',
      'Bearer-credential-abc',
      'deadbeefsignature',
      'AKIAEXAMPLE',
      'derived-key-material',
      'verifier-salt-material',
    ];
    const output = redact({
      password: 'hunter2-password',
      cookie: 'ts_session=ts_session-cookie-value; Path=/',
      loginCode: 'LOGIN-CODE-123',
      claimToken: 'CLAIM-TOKEN-456',
      recoveryCode: 'RECOVERY-CODE-789',
      authorization: 'Bearer Bearer-credential-abc',
      url: 'https://media.example.test/file?X-Amz-Signature=deadbeefsignature&X-Amz-Credential=AKIAEXAMPLE',
      code: 'ABCDEF',
      nested: {
        derivedKey: 'derived-key-material',
        salt: 'verifier-salt-material',
      },
      note: 'sent Authorization: Bearer Bearer-credential-abc; cookie ts_session=ts_session-cookie-value',
    });
    const line = JSON.stringify(output);
    for (const secret of secrets) expect(line).not.toContain(secret);
    expect(line).toContain(REDACTED);
  });

  it('keeps only class name, safe code and frames — never the message or stack text', () => {
    const error = new Error(
      'STORY-TITLE-MARKER failed with Authorization: Bearer stack-secret-123 ts_session=stack-cookie-456'
    );
    const output = JSON.stringify(redact({ error })) as string;
    expect(output).not.toContain('STORY-TITLE-MARKER');
    expect(output).not.toContain('stack-secret-123');
    expect(output).not.toContain('stack-cookie-456');
    expect(output).not.toContain('failed with');
    expect(output).not.toContain('Error:');
    const safe = describeError(error);
    expect(safe.name).toBe('Error');
    expect(safe.frames?.length).toBeGreaterThan(0);
    expect(safe.frames?.every((frame) => frame.startsWith('at '))).toBe(true);
    expect(safe).not.toHaveProperty('message');
    expect(safe).not.toHaveProperty('stack');
  });

  it('extracts only a safe machine code, including from a nested cause', () => {
    const postgres = Object.assign(
      new Error('duplicate key STORY-TITLE-MARKER'),
      {
        code: '23505',
      }
    );
    expect(describeError(postgres)).toMatchObject({ code: '23505' });

    const d1 = Object.assign(new Error('D1_ERROR: constraint failed'), {
      cause: { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    });
    expect(describeError(d1)).toMatchObject({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });

    const unsafeCode = Object.assign(new Error('x'), {
      code: 'story title marker',
    });
    expect(describeError(unsafeCode)).not.toHaveProperty('code');
  });

  it('replaces an untrusted error class name with Error', () => {
    const error = new Error('x');
    error.name = 'STORY-TITLE-MARKER';
    expect(describeError(error).name).toBe('Error');
  });

  it('bounds depth and cycle output instead of throwing', () => {
    const cyclic: Record<string, unknown> = { ok: true };
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
    expect(JSON.stringify(redact(cyclic))).toContain('[circular]');
  });

  it('parses LOG_LEVEL fail-safe', () => {
    expect(parseLogLevel('WARN')).toBe('warn');
    expect(parseLogLevel('invalid')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('accepts only safe client request ids and never derives the logged id', () => {
    expect(acceptClientRequestId('client-request_1.2')).toBe(
      'client-request_1.2'
    );
    expect(acceptClientRequestId('has spaces')).toBeUndefined();
    expect(acceptClientRequestId('x'.repeat(65))).toBeUndefined();
    expect(acceptClientRequestId(undefined)).toBeUndefined();
  });

  it('hashes a client id for correlation without keeping its text', async () => {
    const hash = await hashClientRequestId('correlation-abc_1');
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).not.toContain('correlation');
    expect(await hashClientRequestId('correlation-abc_1')).toBe(hash);
  });
});

describe('structured request logs (#143)', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
  });

  afterAll(() => {
    sqlite.close();
  });

  it('always logs a server-generated id and only echoes a client id', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'CLIENT-ID-MARKER_1' },
    });
    expect(response.status).toBe(200);

    const serverId = response.headers.get(REQUEST_ID_HEADER);
    expect(serverId).toMatch(UUID);
    expect(serverId).not.toBe('CLIENT-ID-MARKER_1');
    expect(response.headers.get(CLIENT_REQUEST_ID_HEADER)).toBe(
      'CLIENT-ID-MARKER_1'
    );

    const [entry] = requestLines(lines);
    expect(entry).toMatchObject({
      requestId: serverId,
      method: 'GET',
      route: '/health',
      status: 200,
    });
    expect(entry.clientRequestIdHash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof entry.durationMs).toBe('number');

    const output = lines.map(({ line }) => line).join('\n');
    expect(output).not.toContain('CLIENT-ID-MARKER_1');
  });

  it('generates an id when the incoming value is unsafe', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'not safe!' },
    });
    const id = response.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(UUID);
    expect(response.headers.get(CLIENT_REQUEST_ID_HEADER)).toBeNull();
    expect(requestLines(lines)[0]).toMatchObject({ requestId: id });
    expect(lines.map(({ line }) => line).join('\n')).not.toContain('not safe');
  });

  it('logs the matched route template, never a raw path, id or query', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });

    const token = 'a'.repeat(64);
    await app.request(`/v2/community/export/download/${token}`);
    await app.request(
      '/v2/public/communities/alpha-slug/stories?access_token=QUERY-MARKER'
    );
    await app.request('/no-such-route-MARKER');

    const entries = requestLines(lines);
    expect(entries.map((entry) => entry.route)).toEqual([
      '/v2/community/export/download/:token',
      '/v2/public/communities/:slug/stories',
      UNMATCHED_ROUTE,
    ]);
    const output = lines.map(({ line }) => line).join('\n');
    expect(output).not.toContain(token);
    expect(output).not.toContain('alpha-slug');
    expect(output).not.toContain('QUERY-MARKER');
    expect(output).not.toContain('no-such-route-MARKER');
    expect(output).not.toContain('?');
  });

  it('exposes the correlation headers to CORS clients', async () => {
    const { logger } = capture();
    const app = createHonoApp({
      repository,
      storage,
      logger,
      publicOrigin: 'https://api.example.test',
      corsOrigins: ['https://app.example.test'],
    });
    const response = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.test',
        'Access-Control-Request-Method': 'GET',
      },
    });
    const exposed = response.headers.get('access-control-expose-headers');
    expect(exposed).toContain(REQUEST_ID_HEADER);
    expect(exposed).toContain(CLIENT_REQUEST_ID_HEADER);
    expect(exposed).toContain(ERROR_ID_HEADER);
  });

  it('never logs story/place/speaker body text', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const body = {
      identifier: 'SACRED-STORY-BODY-MARKER',
      placeText: 'SACRED-PLACE-BODY-MARKER',
      speakerText: 'SACRED-SPEAKER-BODY-MARKER',
      password: 'SACRED-PASSWORD-MARKER',
    };
    const response = await app.request('/v2/auth/prelogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    const output = lines.map(({ line }) => line).join('\n');
    expect(output).not.toContain('SACRED-STORY-BODY-MARKER');
    expect(output).not.toContain('SACRED-PLACE-BODY-MARKER');
    expect(output).not.toContain('SACRED-SPEAKER-BODY-MARKER');
    expect(output).not.toContain('SACRED-PASSWORD-MARKER');
    expect(output).not.toContain('SACRED');
  });

  it('never logs a failed story write title/body/parameters', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const title = 'STORY-TITLE-MARKER';
    const storyBody = 'SACRED-STORY-BODY-MARKER';

    let writeError: unknown;
    try {
      db.insert(tables.stories)
        .values({ title, slug: 'story-slug', communityId: 999_999 })
        .run();
    } catch (error) {
      writeError = error;
    }
    // The shape a failing Drizzle write has on the PostgreSQL/node-sqlite
    // drivers: the message embeds the SQL and its bound parameters.
    const failure = new DrizzleQueryError(
      'insert into "stories" ("title", "description", "community_id") values (?, ?, ?)',
      [title, storyBody, 999_999],
      writeError
    );
    expect(failure.message).toContain(title);

    const readiness = repository.readiness.bind(repository);
    repository.readiness = async () => {
      throw failure;
    };
    let response: Response;
    try {
      response = await app.request('/ready?access_token=QUERY-MARKER');
    } finally {
      repository.readiness = readiness;
    }

    expect(response.status).toBe(503);
    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(UUID);
    const errorId = response.headers.get(ERROR_ID_HEADER);
    expect(errorId).toMatch(UUID);

    const errorLine = lines.find(({ level }) => level === 'error');
    expect(errorLine).toBeDefined();
    const entry = JSON.parse(errorLine!.line);
    expect(entry).toMatchObject({
      level: 'error',
      msg: 'http.error',
      requestId: response.headers.get(REQUEST_ID_HEADER),
      errorId,
      route: '/ready',
      status: 503,
    });
    expect(entry.error).toMatchObject({ name: 'DrizzleQueryError' });
    expect(entry.error.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(entry.error.frames.length).toBeGreaterThan(0);
    expect(entry.error.message).toBeUndefined();
    expect(entry.error.stack).toBeUndefined();
    expect(entry.error.params).toBeUndefined();

    const output = lines.map(({ line }) => line).join('\n');
    for (const marker of [
      title,
      storyBody,
      'QUERY-MARKER',
      'access_token',
      'Failed query',
      'FOREIGN KEY constraint failed',
    ])
      expect(output).not.toContain(marker);
  });

  it('never logs a URL query string carried by an error', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const readiness = repository.readiness.bind(repository);
    repository.readiness = async () => {
      throw new Error(
        'fetch failed for https://media.example.test/bucket/file.mp4?X-Amz-Signature=SIGNATURE-MARKER&token=TOKEN-MARKER&filename=STORY-TITLE-MARKER'
      );
    };
    try {
      expect((await app.request('/ready')).status).toBe(503);
    } finally {
      repository.readiness = readiness;
    }
    const output = lines.map(({ line }) => line).join('\n');
    for (const marker of [
      'SIGNATURE-MARKER',
      'TOKEN-MARKER',
      'STORY-TITLE-MARKER',
      'media.example.test',
      'fetch failed',
    ])
      expect(output).not.toContain(marker);
    expect(output).toContain('http.error');
  });
});

describe('Workers invocation logs stay off (#143)', () => {
  interface WranglerScope {
    observability?: { enabled?: boolean; traces?: { enabled?: boolean } };
    logs?: unknown;
  }
  const config = parseJsonc(
    readFileSync(join(process.cwd(), 'wrangler.jsonc'), 'utf8')
  ) as WranglerScope & { env?: Record<string, WranglerScope> };

  it('keeps Workers observability, traces and invocation logs disabled', () => {
    const scopes: WranglerScope[] = [
      config,
      ...Object.values(config.env ?? {}),
    ];
    for (const scope of scopes) {
      expect(scope.observability?.enabled).toBe(false);
      expect(scope.observability?.traces?.enabled).toBe(false);
      // Invocation logs include raw URLs and bypass application redaction.
      expect(scope.logs).toBeUndefined();
    }
  });
});
