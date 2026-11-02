import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as auditModule from '../../scripts/trusted-audit-baseline.mjs';
import * as dependencyReview from '../../scripts/review-dependency-changes.mjs';

const tempDirs = [];
const SHA512_INTEGRITY = 'sha512-' + 'A'.repeat(86) + '==';
const REPO = 'Terrastories/terrastories-api';
const APPROVAL_DIGEST = 'ab'.repeat(32);
const APPROVAL_LINE = `SECURITY-AUDIT-APPROVAL v1 policySha256=${APPROVAL_DIGEST} trackingIssue=141`;

function tempDir(prefix = 'terrastories-trusted-audit-hardening-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function registryEntry(name, version, extra = {}) {
  return {
    version,
    resolved: auditModule.canonicalRegistryTarball(name, version),
    integrity: SHA512_INTEGRITY,
    ...extra,
  };
}

function lockOf(packages) {
  return {
    name: 'hardening-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'hardening-fixture', version: '1.0.0' },
      ...packages,
    },
  };
}

// Same reviewed-policy construction as the approved-lockfile test in
// security-scripts.test.js.
function approvedPolicy(advisories = []) {
  const policy = {
    trackingIssue: 141,
    minimumSeverity: 'moderate',
    expires: '2099-12-31',
    review: {
      status: 'accepted',
      reviewedBy: 'Maintainer',
      reviewedOn: '2026-10-31',
      rationale: 'Reviewed empty baseline.',
      advisoriesSha256: auditModule.computeAdvisorySetDigest(advisories),
    },
  };
  policy.review.policySha256 = auditModule.computeReviewedPolicyDigest(
    advisories,
    policy
  );
  return policy;
}

function writeApprovedFixture(dir, lock = lockOf({})) {
  mkdirSync(join(dir, 'config'));
  mkdirSync(join(dir, 'bin'));
  const policy = approvedPolicy();
  writeJson(join(dir, 'config/security-audit-policy.json'), policy);
  writeJson(join(dir, 'config/security-audit-baseline.json'), {
    trackingIssue: 141,
    advisories: [],
  });
  writeJson(join(dir, 'package.json'), {
    name: 'untrusted-fixture',
    version: '1.0.0',
  });
  writeJson(join(dir, 'package-lock.json'), lock);
  return policy;
}

function writeFakeNpm(dir, marker) {
  writeFileSync(
    join(dir, 'bin/npm'),
    `#!/usr/bin/env node\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nconsole.log(JSON.stringify({ vulnerabilities: {} }));\n`
  );
  chmodSync(join(dir, 'bin/npm'), 0o755);
}

function stubTrustedApproval(policy) {
  vi.stubEnv('GITHUB_REPOSITORY', REPO);
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  vi.stubGlobal('fetch', async (url) => {
    if (url.includes('/issues/141/comments?')) {
      return new Response(
        JSON.stringify([
          {
            id: 1,
            body: `SECURITY-AUDIT-APPROVAL v1 policySha256=${policy.review.policySha256} trackingIssue=141`,
            user: { login: 'trusted-maintainer' },
            created_at: '2026-09-27T20:00:00Z',
            updated_at: '2026-09-27T20:00:00Z',
          },
        ]),
        { status: 200 }
      );
    }
    return new Response(JSON.stringify({ permission: 'write' }), {
      status: 200,
    });
  });
}

const substitutedLodash = lockOf({
  'node_modules/lodash': {
    version: '4.18.1',
    resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz',
    integrity: SHA512_INTEGRITY,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('B1 lockfile source binding', () => {
  it('rejects the reviewer substitution of a 4.17.20 tarball under lodash@4.18.1', () => {
    expect(() =>
      auditModule.validateLockfileSources(substitutedLodash)
    ).toThrow(/node_modules\/lodash.*registry tarball for lodash@4\.18\.1/s);
  });

  it.each([
    ['https://example.invalid/lodash-4.17.20.tgz'],
    ['git+ssh://git@github.com/lodash/lodash.git#abc123'],
    ['file:../lodash'],
    ['http://registry.npmjs.org/lodash/-/lodash-4.18.1.tgz'],
    ['https://registry.yarnpkg.com/lodash/-/lodash-4.18.1.tgz'],
    [undefined],
  ])('rejects non-registry source %s', (resolved) => {
    const entry = { version: '4.18.1', integrity: SHA512_INTEGRITY };
    if (resolved !== undefined) {
      entry.resolved = resolved;
    }
    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({ 'node_modules/lodash': entry })
      )
    ).toThrow(/resolved is not the registry tarball/);
  });

  it('rejects linked, bundled, and non-node_modules entries', () => {
    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({
          'node_modules/x': { link: true, resolved: 'packages/x' },
        })
      )
    ).toThrow(/linked local packages are not allowed/);

    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({
          'node_modules/x': { inBundle: true, version: '1.0.0' },
        })
      )
    ).toThrow(/bundled dependencies are not allowed/);

    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({
          'packages/foo': registryEntry('foo', '1.0.0'),
        })
      )
    ).toThrow(/only node_modules package entries are allowed/);
  });

  it('accepts canonical plain, scoped, nested, alias, and root entries', () => {
    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({
          'node_modules/lodash': registryEntry('lodash', '4.18.1'),
          'node_modules/@scope/pkg': registryEntry('@scope/pkg', '1.0.0'),
          'node_modules/a/node_modules/b': registryEntry('b', '1.0.0'),
          'node_modules/foo': registryEntry('bar', '1.0.0', { name: 'bar' }),
        })
      )
    ).not.toThrow();
  });

  it('accepts the repository package-lock.json', () => {
    const lock = JSON.parse(
      readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')
    );
    expect(() => auditModule.validateLockfileSources(lock)).not.toThrow();
  });

  it('rejects missing and non-sha512 integrity', () => {
    const { integrity: _omit, ...withoutIntegrity } = registryEntry(
      'lodash',
      '4.18.1'
    );
    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({ 'node_modules/lodash': withoutIntegrity })
      )
    ).toThrow(/sha512 integrity/);

    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({
          'node_modules/lodash': registryEntry('lodash', '4.18.1', {
            integrity: 'sha1-abc=',
          }),
        })
      )
    ).toThrow(/sha512 integrity/);
  });

  it('rejects lockfileVersion 1 and locks without a packages map', () => {
    expect(() =>
      auditModule.validateLockfileSources({
        lockfileVersion: 1,
        packages: {},
      })
    ).toThrow(/lockfileVersion 2 or 3/);

    expect(() =>
      auditModule.validateLockfileSources({ lockfileVersion: 3 })
    ).toThrow(/lockfileVersion 2 or 3/);
  });

  it('fails main before npm runs when the lockfile substitutes a tarball', async () => {
    const dir = tempDir();
    const marker = join(dir, 'npm-ran.json');
    const policy = writeApprovedFixture(dir, substitutedLodash);
    writeFakeNpm(dir, marker);
    vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env.PATH}`);
    stubTrustedApproval(policy);

    await expect(auditModule.main({ dataDir: dir })).rejects.toThrow(
      /registry tarball/
    );
    expect(existsSync(marker)).toBe(false);
  });
});

describe('S5 lock entry version', () => {
  it('rejects an entry without a version even when resolved and integrity are present', () => {
    expect(() =>
      auditModule.validateLockfileSources(
        lockOf({
          'node_modules/lodash': {
            resolved: auditModule.canonicalRegistryTarball('lodash', '4.18.1'),
            integrity: SHA512_INTEGRITY,
          },
        })
      )
    ).toThrow(/missing or invalid version/);
  });
});

describe('S1 untrusted config reads', () => {
  it('rejects a policy file that is a symlink, without echoing its contents', async () => {
    const dir = tempDir();
    const policy = writeApprovedFixture(dir);
    const secretTarget = join(dir, 'secret-target.json');
    writeFileSync(secretTarget, 'GITHUB_TOKEN=ghs_secretvalue123');
    unlinkSync(join(dir, 'config/security-audit-policy.json'));
    symlinkSync(secretTarget, join(dir, 'config/security-audit-policy.json'));
    stubTrustedApproval(policy);

    const error = await auditModule.main({ dataDir: dir }).then(
      () => null,
      (caught) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/not a symlink/);
    expect(error.message).not.toContain('GITHUB_TOK');
    expect(error.message).not.toContain('ghs_');
  });

  it('rejects a config directory that is a symlink to a real directory', async () => {
    const dir = tempDir();
    const real = tempDir();
    writeApprovedFixture(real);
    writeJson(join(dir, 'package.json'), { name: 'x', version: '1.0.0' });
    writeJson(join(dir, 'package-lock.json'), lockOf({}));
    symlinkSync(join(real, 'config'), join(dir, 'config'));
    stubTrustedApproval(approvedPolicy());

    await expect(auditModule.main({ dataDir: dir })).rejects.toThrow(
      /real directory/
    );
  });

  it('rejects a non-symlink policy file that is not JSON, without echoing its contents', async () => {
    const dir = tempDir();
    writeApprovedFixture(dir);
    writeFileSync(
      join(dir, 'config/security-audit-policy.json'),
      'GITHUB_TOKEN=ghs_secretvalue123'
    );

    const error = await auditModule.main({ dataDir: dir }).then(
      () => null,
      (caught) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/not valid JSON/);
    expect(error.message).not.toContain('GITHUB_TOK');
  });

  it('enforces the byte limit in readUntrustedFile', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'big.json'), 'x'.repeat(17));
    writeFileSync(join(dir, 'exact.json'), 'x'.repeat(16));

    await expect(
      auditModule.readUntrustedFile(dir, 'big.json', 16)
    ).rejects.toThrow(/exceeds the 16-byte limit/);

    const bytes = await auditModule.readUntrustedFile(dir, 'exact.json', 16);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(bytes.length).toBe(16);
  });

  it('rejects a package-lock.json symlink to /dev/zero without blocking', async () => {
    const dir = tempDir();
    const policy = writeApprovedFixture(dir);
    unlinkSync(join(dir, 'package-lock.json'));
    symlinkSync('/dev/zero', join(dir, 'package-lock.json'));
    stubTrustedApproval(policy);

    await expect(auditModule.main({ dataDir: dir })).rejects.toThrow(
      /not a symlink/
    );
  }, 5000);
});

describe('S2 dev to prod promotion', () => {
  const esbuildAdvisory = {
    source: '1',
    package: 'esbuild',
    severity: 'moderate',
    url: 'https://example.invalid/esbuild',
    nodes: ['node_modules/esbuild'],
    nodeScopes: { 'node_modules/esbuild': 'dev' },
  };
  const esbuildReport = {
    vulnerabilities: {
      esbuild: {
        nodes: ['node_modules/esbuild'],
        via: [
          {
            source: 1,
            severity: 'moderate',
            url: 'https://example.invalid/esbuild',
          },
        ],
      },
    },
  };

  function esbuildBaseline(advisory = esbuildAdvisory) {
    return { trackingIssue: 141, advisories: [advisory] };
  }

  function esbuildPolicy(advisories) {
    const policy = {
      trackingIssue: 141,
      minimumSeverity: 'moderate',
      expires: '2099-12-31',
      review: {
        status: 'accepted',
        reviewedBy: 'Maintainer',
        reviewedOn: '2026-10-31',
        rationale: 'Reviewed esbuild dev-only debt.',
        advisoriesSha256: auditModule.computeAdvisorySetDigest(advisories),
      },
    };
    policy.review.policySha256 = auditModule.computeReviewedPolicyDigest(
      advisories,
      policy
    );
    return policy;
  }

  it('does not flag an accepted dev-only path that stays dev', () => {
    const baseline = esbuildBaseline();
    const policy = esbuildPolicy(baseline.advisories);
    const lock = lockOf({
      'node_modules/esbuild': { version: '0.19.0', dev: true },
    });

    const comparison = auditModule.compareAuditAdvisories(
      baseline,
      policy,
      esbuildReport,
      lock
    );
    expect(comparison.pathChanges).toHaveLength(0);
  });

  it('flags the same advisory once esbuild moves into the prod install', () => {
    const baseline = esbuildBaseline();
    const policy = esbuildPolicy(baseline.advisories);
    const lock = lockOf({
      'node_modules/esbuild': { version: '0.19.0' },
    });

    const { pathChanges } = auditModule.compareAuditAdvisories(
      baseline,
      policy,
      esbuildReport,
      lock
    );
    expect(pathChanges).toHaveLength(1);
    const diagnostic = auditModule.formatPathChangeDiagnostic(pathChanges[0]);
    expect(diagnostic).toContain('(dev)');
    expect(diagnostic).toContain('(prod)');
  });

  it('fails closed when the accepted baseline has no recorded scopes', () => {
    const legacyAdvisory = {
      source: '1',
      package: 'esbuild',
      severity: 'moderate',
      url: 'https://example.invalid/esbuild',
      nodes: ['node_modules/esbuild'],
    };
    const baseline = esbuildBaseline(legacyAdvisory);
    const policy = esbuildPolicy(baseline.advisories);
    const lock = lockOf({
      'node_modules/esbuild': { version: '0.19.0', dev: true },
    });

    const { pathChanges } = auditModule.compareAuditAdvisories(
      baseline,
      policy,
      esbuildReport,
      lock
    );
    expect(pathChanges).toHaveLength(1);
  });

  it('fails main when an accepted dev-only package enters the prod install', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'config'));
    mkdirSync(join(dir, 'bin'));
    const baseline = esbuildBaseline();
    const policy = esbuildPolicy(baseline.advisories);
    writeJson(join(dir, 'config/security-audit-policy.json'), policy);
    writeJson(join(dir, 'config/security-audit-baseline.json'), baseline);
    writeJson(join(dir, 'package.json'), { name: 'x', version: '1.0.0' });
    writeJson(
      join(dir, 'package-lock.json'),
      lockOf({ 'node_modules/esbuild': registryEntry('esbuild', '0.19.0') })
    );
    writeFileSync(
      join(dir, 'bin/npm'),
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(esbuildReport))});\n`
    );
    chmodSync(join(dir, 'bin/npm'), 0o755);
    vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env.PATH}`);
    stubTrustedApproval(policy);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await expect(auditModule.main({ dataDir: dir })).rejects.toThrow(
      /Review dependency debt/
    );
    expect(stderr.mock.calls.join('\n')).toMatch(
      /node_modules\/esbuild \(dev\).*node_modules\/esbuild \(prod\)/s
    );
  });

  it('changes the advisory-set digest when a node scope changes', () => {
    const dev = auditModule.computeAdvisorySetDigest([esbuildAdvisory]);
    const prod = auditModule.computeAdvisorySetDigest([
      {
        ...esbuildAdvisory,
        nodeScopes: { 'node_modules/esbuild': 'prod' },
      },
    ]);
    expect(dev).not.toBe(prod);
  });

  it('binds scopes from the lock and rejects report paths missing from it', () => {
    expect(() =>
      auditModule.annotateAdvisoryScopes(
        [
          {
            source: '1',
            package: 'esbuild',
            severity: 'moderate',
            nodes: ['node_modules/missing'],
          },
        ],
        lockOf({})
      )
    ).toThrow(/does not contain/);

    expect(auditModule.lockEntryScope({ dev: true, optional: true })).toBe(
      'dev+optional'
    );
    expect(auditModule.lockEntryScope({})).toBe('prod');
  });
});

describe('S4 external approval lookup', () => {
  const policy = {
    trackingIssue: 141,
    review: { policySha256: APPROVAL_DIGEST },
  };

  function comment({
    id = 1,
    login,
    body = APPROVAL_LINE,
    created = '2026-10-01T00:00:00Z',
    updated = created,
  }) {
    return {
      id,
      body,
      user: { login },
      created_at: created,
      updated_at: updated,
    };
  }

  // pages[n] is the comment array returned for ?page=n+1.
  function githubFetch({ pages = [[]], permissions = {}, statuses = {} }) {
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes('/collaborators/')) {
        const login = decodeURIComponent(
          url.split('/collaborators/')[1].split('/permission')[0]
        );
        if (statuses[login]) {
          return new Response('{}', { status: statuses[login] });
        }
        return new Response(
          JSON.stringify({ permission: permissions[login] ?? 'none' }),
          { status: 200 }
        );
      }
      const page = Number(new URL(url).searchParams.get('page'));
      return new Response(JSON.stringify(pages[page - 1] ?? []), {
        status: 200,
      });
    });
    const permissionCalls = () =>
      fetchImpl.mock.calls.filter(([url]) => url.includes('/collaborators/'))
        .length;
    return { fetchImpl, permissionCalls };
  }

  function verify(fetchImpl) {
    return auditModule.verifyExternalAuditApproval(policy, {
      repository: REPO,
      token: 't',
      fetchImpl,
    });
  }

  it('ignores near-matches without any permission lookup', async () => {
    const mismatchedDigest = `SECURITY-AUDIT-APPROVAL v1 policySha256=${'cd'.repeat(32)} trackingIssue=141`;
    const { fetchImpl, permissionCalls } = githubFetch({
      pages: [
        [
          comment({ id: 1, login: 'u1', body: `${APPROVAL_LINE} please` }),
          comment({
            id: 2,
            login: 'u2',
            body: `\`\`\`\n${APPROVAL_LINE}\n\`\`\`\nextra text`,
          }),
          comment({
            id: 3,
            login: 'u3',
            body: APPROVAL_LINE.replace(
              'SECURITY-AUDIT-APPROVAL',
              'security-audit-approval'
            ),
          }),
          comment({ id: 4, login: 'u4', body: mismatchedDigest }),
          comment({ id: 5, login: 'u5', body: `${APPROVAL_LINE}\nnot yet` }),
        ],
      ],
    });

    await expect(verify(fetchImpl)).rejects.toThrow(
      /requires an exact external approval/
    );
    expect(permissionCalls()).toBe(0);
  });

  it('stops at the first write user and skips earlier read-only copies', async () => {
    const { fetchImpl, permissionCalls } = githubFetch({
      pages: [
        [
          comment({ id: 1, login: 'reader-a' }),
          comment({ id: 2, login: 'reader-b' }),
          comment({ id: 3, login: 'writer-c' }),
          comment({ id: 4, login: 'writer-d' }),
        ],
      ],
      permissions: {
        'reader-a': 'read',
        'reader-b': 'read',
        'writer-c': 'write',
        'writer-d': 'write',
      },
    });

    await expect(verify(fetchImpl)).resolves.toMatchObject({
      author: 'writer-c',
      permission: 'write',
    });
    expect(permissionCalls()).toBe(3);
  });

  it('continues past a candidate whose permission lookup returns 404', async () => {
    const { fetchImpl } = githubFetch({
      pages: [
        [
          comment({ id: 1, login: 'ghost' }),
          comment({ id: 2, login: 'writer' }),
        ],
      ],
      permissions: { writer: 'write' },
      statuses: { ghost: 404 },
    });

    await expect(verify(fetchImpl)).resolves.toMatchObject({
      author: 'writer',
    });
  });

  it('fails closed when a permission lookup returns HTTP 500', async () => {
    const { fetchImpl } = githubFetch({
      pages: [[comment({ id: 1, login: 'user-500' })]],
      statuses: { 'user-500': 500 },
    });

    await expect(verify(fetchImpl)).rejects.toThrow(
      /permission lookup.*HTTP 500/
    );
  });

  it('caps permission lookups at 25 matching candidates', async () => {
    const copies = Array.from({ length: 26 }, (_, index) =>
      comment({ id: index + 1, login: `reader-${index}` })
    );
    const { fetchImpl } = githubFetch({ pages: [copies] });

    await expect(verify(fetchImpl)).rejects.toThrow(
      /more than 25 matching comments/
    );
  });

  it('finds a trusted approval on page 2 but gives up after 20 pages', async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: 'not an approval',
      user: { login: 'someone' },
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    }));

    const paged = githubFetch({
      pages: [filler, [comment({ id: 500, login: 'trusted-m' })]],
      permissions: { 'trusted-m': 'write' },
    });
    await expect(verify(paged.fetchImpl)).resolves.toMatchObject({
      author: 'trusted-m',
    });

    const endless = githubFetch({
      pages: Array.from({ length: 20 }, () => filler),
    });
    await expect(verify(endless.fetchImpl)).rejects.toThrow(
      /exceeded 20 pages/
    );
  });

  it('passes an AbortSignal and reports a timeout as a timeout', async () => {
    const signals = [];
    const fetchImpl = vi.fn(async (_url, init) => {
      signals.push(init?.signal);
      throw new DOMException('x', 'TimeoutError');
    });

    await expect(verify(fetchImpl)).rejects.toThrow(/timed out/);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('skips an edited exact copy without a permission lookup', async () => {
    const { fetchImpl, permissionCalls } = githubFetch({
      pages: [
        [
          comment({
            id: 1,
            login: 'writer',
            created: '2026-10-01T00:00:00Z',
            updated: '2026-10-02T00:00:00Z',
          }),
        ],
      ],
      permissions: { writer: 'write' },
    });

    await expect(verify(fetchImpl)).rejects.toThrow(
      /requires an exact external approval/
    );
    expect(permissionCalls()).toBe(0);
  });
});

describe('N1 policy and approval identifiers', () => {
  const policy = approvedPolicy();

  it.each([['141'], ['0x8D'], [141.5], [0]])(
    'rejects trackingIssue %j in the baseline policy',
    (trackingIssue) => {
      expect(() =>
        auditModule.validateBaselinePolicy(
          { ...policy, trackingIssue },
          '2026-10-31'
        )
      ).toThrow(/Invalid security audit policy metadata/);
    }
  );

  it('rejects a string trackingIssue during external approval verification', async () => {
    await expect(
      auditModule.verifyExternalAuditApproval(
        { ...policy, trackingIssue: '141' },
        { repository: REPO, token: 't', fetchImpl: vi.fn() }
      )
    ).rejects.toThrow(/must be recorded under #141/);
  });
});

describe('N2 approval line parsing', () => {
  it('accepts the exact line with surrounding whitespace and newlines', () => {
    expect(
      auditModule.parseExternalAuditApproval(`\n  ${APPROVAL_LINE}  \n`)
    ).toEqual({ policySha256: APPROVAL_DIGEST, trackingIssue: 141 });
  });

  it('rejects a lowercase prefix, a fenced copy, and a line followed by text', () => {
    expect(
      auditModule.parseExternalAuditApproval(
        APPROVAL_LINE.replace(
          'SECURITY-AUDIT-APPROVAL',
          'security-audit-approval'
        )
      )
    ).toBeNull();
    expect(
      auditModule.parseExternalAuditApproval(
        `\`\`\`\n${APPROVAL_LINE}\n\`\`\`\nextra`
      )
    ).toBeNull();
    expect(
      auditModule.parseExternalAuditApproval(`${APPROVAL_LINE}\nnot yet`)
    ).toBeNull();
  });
});

describe('N5 dependency change fields', () => {
  it('reports hasInstallScript and dev changes for same-version entries', () => {
    const changes = dependencyReview.summarizeDependencyChanges(
      {
        packages: {
          'node_modules/alpha': {
            version: '1.0.0',
            hasInstallScript: false,
          },
          'node_modules/beta': { version: '1.0.0', dev: true },
        },
      },
      {
        packages: {
          'node_modules/alpha': {
            version: '1.0.0',
            hasInstallScript: true,
          },
          'node_modules/beta': { version: '1.0.0' },
        },
      }
    );

    const alpha = changes.find((change) => change.name === 'alpha');
    const beta = changes.find((change) => change.name === 'beta');
    expect(alpha.changedFields).toContain('hasInstallScript');
    expect(beta.changedFields).toContain('dev');
  });
});

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createReviewRepo(baseLock) {
  const cwd = tempDir('terrastories-review-hardening-');
  writeJson(join(cwd, 'package.json'), { name: 'x', version: '1.0.0' });
  writeJson(join(cwd, 'package-lock.json'), baseLock);
  git(['init', '-q'], cwd);
  git(['config', 'user.name', 'Terrastories Tests'], cwd);
  git(['config', 'user.email', 'tests@terrastories.invalid'], cwd);
  git(['add', '.'], cwd);
  git(['commit', '-q', '-m', 'base'], cwd);
  return { cwd, baseSha: git(['rev-parse', 'HEAD'], cwd) };
}

describe('Greptile P1 npm-shrinkwrap.json precedence', () => {
  it('allows a data checkout without a shrinkwrap file', async () => {
    await expect(
      auditModule.assertNoShrinkwrap(tempDir())
    ).resolves.toBeUndefined();
  });

  it.each([
    ['regular file', (path) => writeJson(path, lockOf({}))],
    ['dangling symlink', (path) => symlinkSync('/nonexistent-target', path)],
    ['directory', (path) => mkdirSync(path)],
  ])('rejects a shrinkwrap %s', async (_kind, create) => {
    const dir = tempDir();
    create(join(dir, 'npm-shrinkwrap.json'));
    await expect(auditModule.assertNoShrinkwrap(dir)).rejects.toThrow(
      /npm-shrinkwrap\.json is not allowed/
    );
  });

  it('fails main before approval lookup or npm audit when a shrinkwrap exists', async () => {
    const dir = tempDir();
    const marker = join(dir, 'npm-ran.json');
    writeApprovedFixture(dir, lockOf({}));
    writeJson(join(dir, 'npm-shrinkwrap.json'), substitutedLodash);
    writeFakeNpm(dir, marker);
    vi.stubEnv('PATH', `${join(dir, 'bin')}:${process.env.PATH}`);
    vi.stubEnv('GITHUB_REPOSITORY', REPO);
    vi.stubEnv('GITHUB_TOKEN', 'test-token');
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);

    await expect(auditModule.main({ dataDir: dir })).rejects.toThrow(
      /npm-shrinkwrap\.json is not allowed/
    );
    expect(existsSync(marker)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports an added shrinkwrap in dependency review and rejects the PR', async () => {
    const { cwd, baseSha } = createReviewRepo(lockOf({}));
    writeJson(join(cwd, 'npm-shrinkwrap.json'), substitutedLodash);
    git(['add', 'npm-shrinkwrap.json'], cwd);
    git(['commit', '-q', '-m', 'add shrinkwrap'], cwd);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(dependencyReview.main({ cwd, baseSha })).rejects.toThrow(
      /dependency audit rejected/i
    );
    expect(log.mock.calls.flat().join('\n')).toMatch(
      /npm-shrinkwrap\.json changed.*trusted audit rejects it/
    );
  });
});

describe('Greptile P2 large lockfiles in dependency review', () => {
  it('summarizes a lockfile larger than 1 MiB', async () => {
    const { cwd, baseSha } = createReviewRepo(lockOf({}));
    const packages = {};
    for (let index = 0; index < 6000; index += 1) {
      const name = `pkg-${index}`;
      packages[`node_modules/${name}`] = registryEntry(name, '1.0.0', {
        license: 'x'.repeat(40),
      });
    }
    writeJson(join(cwd, 'package-lock.json'), lockOf(packages));
    expect(readFileSync(join(cwd, 'package-lock.json')).length).toBeGreaterThan(
      1024 * 1024
    );
    git(['add', 'package-lock.json'], cwd);
    git(['commit', '-q', '-m', 'large lock'], cwd);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      dependencyReview.main({
        cwd,
        baseSha,
        auditCommand: [process.execPath, '-e', 'process.exit(0)'],
      })
    ).resolves.toBeUndefined();
    expect(log.mock.calls.flat().join('\n')).toMatch(
      /6000 locked dependency changes detected/
    );
  });
});
