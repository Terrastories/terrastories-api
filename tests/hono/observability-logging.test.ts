/**
 * Privacy-safe observability (#143).
 *
 * Proves the structured request log carries a request/correlation id, that the
 * one redaction pass removes credentials/tokens/signatures, and that request
 * bodies (story/place/speaker text) and failing-request error stacks never
 * reach a log line.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createHonoApp } from '../../src/hono-app.js';
import { HonoFoundationRepository } from '../../src/repositories/hono-foundation.repository.js';
import {
  createJsonLogger,
  parseLogLevel,
  redact,
  REDACTED,
} from '../../src/shared/observability/log.js';
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  safeRequestPath,
} from '../../src/shared/observability/request-log.js';

const sqlite = new Sqlite(':memory:');
sqlite.pragma('foreign_keys = ON');
const db = drizzle(sqlite);
const repository = new HonoFoundationRepository(db);
const storage = { read: async () => null };

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

  it('scrubs secrets inside an error name, message and stack', () => {
    const error = new Error(
      'request failed: Authorization: Bearer stack-secret-123 ts_session=stack-cookie-456'
    );
    error.stack = `${error.stack}\n    at handler (Bearer stack-secret-123)`;
    const line = JSON.stringify(redact({ error }));
    expect(line).not.toContain('stack-secret-123');
    expect(line).not.toContain('stack-cookie-456');
    expect(line).toContain('stack');
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

  it('redacts opaque export tokens in a request path', () => {
    const token = 'a'.repeat(64);
    expect(safeRequestPath(`/v2/community/export/download/${token}`)).toBe(
      `/v2/community/export/download/${REDACTED}`
    );
    expect(safeRequestPath('/v2/public/communities/alpha/stories')).toBe(
      '/v2/public/communities/alpha/stories'
    );
  });

  it('accepts only safe request ids and generates one otherwise', () => {
    expect(resolveRequestId('client-request_1.2')).toBe('client-request_1.2');
    expect(resolveRequestId('has spaces')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(resolveRequestId('x'.repeat(65))).not.toBe('x'.repeat(65));
    expect(resolveRequestId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });
});

describe('structured request logs (#143)', () => {
  beforeAll(() => {
    migrate(db, { migrationsFolder: './src/db/migrations' });
  });

  afterAll(() => {
    sqlite.close();
  });

  it('echoes a safe incoming request id and logs one JSON line for it', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'correlation-abc_1' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('correlation-abc_1');

    const requestLines = parsed(lines).filter(
      (entry) => entry.msg === 'http.request'
    );
    expect(requestLines).toHaveLength(1);
    expect(requestLines[0]).toMatchObject({
      requestId: 'correlation-abc_1',
      method: 'GET',
      path: '/health',
      status: 200,
    });
    expect(typeof requestLines[0].durationMs).toBe('number');
  });

  it('generates and echoes a request id when the incoming value is unsafe', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    const response = await app.request('/health', {
      headers: { 'x-request-id': 'not safe!' },
    });
    const id = response.headers.get(REQUEST_ID_HEADER);
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(id).not.toBe('not safe!');
    expect(
      parsed(lines).find((entry) => entry.msg === 'http.request')
    ).toMatchObject({ requestId: id });
  });

  it('exposes the request id header to CORS clients', async () => {
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
    expect(response.headers.get('access-control-expose-headers')).toContain(
      REQUEST_ID_HEADER
    );
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

  it('redacts secrets in the error logged for a failing request and keeps the id', async () => {
    const { lines, logger } = capture();
    const app = createHonoApp({ repository, storage, logger });
    repository.readiness = async () => {
      throw new Error(
        'probe failed Authorization: Bearer failure-secret-123 ts_session=failure-cookie-456'
      );
    };
    const response = await app.request('/ready', {
      headers: { 'x-request-id': 'failing-request-1' },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe('failing-request-1');

    const errorLine = lines.find(({ level }) => level === 'error');
    expect(errorLine).toBeDefined();
    const entry = JSON.parse(errorLine!.line);
    expect(entry).toMatchObject({
      level: 'error',
      msg: 'http.error',
      requestId: 'failing-request-1',
      status: 503,
    });
    expect(errorLine!.line).not.toContain('failure-secret-123');
    expect(errorLine!.line).not.toContain('failure-cookie-456');
    expect(errorLine!.line).toContain(REDACTED);
  });
});
