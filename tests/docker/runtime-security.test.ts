import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
const productionStage = dockerfile.split(' AS production')[1] ?? '';

describe('production container security', () => {
  it('upgrades supported Alpine packages before installing runtime dependencies', () => {
    expect(productionStage).toContain('apk upgrade --no-cache');
  });

  it('does not ship npm, npx, Corepack, or Yarn in the runtime image', () => {
    expect(productionStage).toContain('/usr/local/lib/node_modules/npm');
    expect(productionStage).toContain('/usr/local/lib/node_modules/corepack');
    expect(productionStage).toContain('/opt/yarn-v1.22.22');
    expect(productionStage).toContain('/usr/local/bin/npm');
    expect(productionStage).toContain('/usr/local/bin/npx');
    expect(productionStage).toContain('/usr/local/bin/corepack');
    expect(productionStage).toContain('/usr/local/bin/yarn');
    expect(productionStage).toContain('/usr/local/bin/yarnpkg');
    expect(productionStage).toContain('exec node dist/hono-server.js');
    expect(productionStage).not.toContain('dist/server.js"]');
    expect(productionStage).not.toContain('CMD ["npm", "start"]');
  });

  it('runs the V2 Hono server on 3001 with a /health check and HONO_* defaults', () => {
    expect(productionStage).toContain('EXPOSE 3001');
    expect(productionStage).toContain('http://127.0.0.1:3001/health');
    expect(productionStage).toContain('HONO_HOST=0.0.0.0');
    expect(productionStage).toContain('HONO_STORAGE_ROOT=/app/uploads');
    expect(productionStage).not.toContain('3000');
  });

  it('runs V2 in the production and field-kit Compose profiles', () => {
    for (const file of [
      'docker-compose.prod.yml',
      'docker-compose.field-kit.yml',
    ]) {
      const compose = readFileSync(join(process.cwd(), file), 'utf8');
      expect(compose).toContain('127.0.0.1:3001');
      expect(compose).toContain('AUTH_SERVER_SECRET');
      expect(compose).toContain('BOOTSTRAP_SECRET');
      expect(compose).toContain('HONO_PUBLIC_ORIGIN');
      expect(compose).toContain('HONO_STORAGE_ROOT=/app/uploads');
      expect(compose).not.toContain('exec node dist/server.js');
      expect(compose).toContain('ERASURE_RECORDS_ROOT=/app/erasure-records');
      // nginx must not mount V2 media/erasure volumes.
      const nginx = compose.slice(compose.indexOf('\n  nginx:'));
      const nginxBlock = nginx.slice(0, nginx.indexOf('\n  # ====', 10));
      expect(nginxBlock).not.toMatch(/^\s+- (uploads_data|erasure_records):/m);
    }
  });
});
