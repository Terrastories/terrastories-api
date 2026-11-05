import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Runtime mode is an operator opt-in (unset NODE_ENV means production).
// Scripts that are development by definition opt in themselves; production
// and shared scripts must inherit NODE_ENV from the operator.
const { scripts } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
);

const DEV_ONLY_SCRIPTS = ['dev', 'db:seed'];
const MUST_NOT_SET_SCRIPTS = ['start', 'build', 'db:migrate'];
const DEV_ONLY_PATTERN = /^(dev(:|$)|seed(:|$)|db:seed(:|$))/;

describe('npm script runtime mode contract', () => {
  it.each(DEV_ONLY_SCRIPTS)('%s sets NODE_ENV=development', (name) => {
    expect(scripts[name]).toMatch(/^NODE_ENV=development\s/);
  });

  it('every dev-only script name is pinned to development', () => {
    for (const name of Object.keys(scripts).filter((n) =>
      DEV_ONLY_PATTERN.test(n)
    )) {
      expect(scripts[name], name).toMatch(/^NODE_ENV=development\s/);
    }
  });

  it.each(MUST_NOT_SET_SCRIPTS)('%s does not set NODE_ENV', (name) => {
    expect(scripts[name]).toBeDefined();
    expect(scripts[name]).not.toMatch(/NODE_ENV/);
  });

  it('only dev-only scripts set NODE_ENV=development', () => {
    const setters = Object.keys(scripts).filter((n) =>
      /NODE_ENV=development/.test(scripts[n])
    );
    expect(setters.every((n) => DEV_ONLY_PATTERN.test(n))).toBe(true);
  });

  it('no script forces a non-development runtime mode', () => {
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/NODE_ENV=(?!development\s)/);
    }
  });
});
