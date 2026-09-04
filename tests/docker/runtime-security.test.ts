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
    expect(productionStage).toContain('CMD ["node", "dist/server.js"]');
    expect(productionStage).not.toContain('CMD ["npm", "start"]');
  });
});
