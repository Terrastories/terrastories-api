import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('issue #141 production runtime boundaries', () => {
  it('does not auto-run unsupported PostgreSQL migrations during API startup', async () => {
    const compose = await readFile('docker-compose.prod.yml', 'utf8');

    expect(compose).not.toContain('dist/db/migrate.js');
    expect(compose).toMatch(
      /command:\s*(?:\[[^\n]*node[^\n]*dist\/server\.js|[^\n]*node dist\/server\.js)/
    );
  });
});
