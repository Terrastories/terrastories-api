import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('issue #141 production runtime boundaries', () => {
  it('fails closed on PostgreSQL migration readiness before API startup', async () => {
    const compose = await readFile('docker-compose.prod.yml', 'utf8');

    expect(compose).toContain('node dist/db/migrate.js');
    expect(compose).toContain('exec node dist/server.js');
    expect(compose).not.toMatch(/\bnpm\b/);
  });
});
