import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CookieJar } from '../../../scripts/walkthrough/client.js';
import { COVERAGE_ROWS } from '../../../scripts/walkthrough/coverage.js';
import { startLocalApp } from '../../../scripts/walkthrough/local-app.js';
import { newState, type Config } from '../../../scripts/walkthrough/context.js';
import { stewardChapter } from '../../../scripts/walkthrough/chapters/steward.js';
import {
  parseArgs,
  runWalkthrough,
  selectPersonas,
} from '../../../scripts/walkthrough/run.js';
import { Walk } from '../../../scripts/walkthrough/walk.js';

const everythingSteps = (records: Array<{ actor: string }>) =>
  records.map((r) => r.actor).join('\n');

const outDir = () => mkdtemp(join(tmpdir(), 'tsapi-walkthrough-out-'));

async function readAll(dir: string): Promise<string> {
  const names = await readdir(dir);
  const parts = await Promise.all(
    names.map((n) => readFile(join(dir, n), 'utf8'))
  );
  return parts.join('\n');
}

describe('walkthrough runner', () => {
  it('walks every persona end to end against a local app and covers every handoff row', async () => {
    const app = await startLocalApp();
    try {
      const before = await app.snapshotTarget();
      const dir = await outDir();
      const cfg: Config = {
        baseUrl: app.baseUrl,
        community: app.community,
        adminIdentifier: app.admin.identifier,
        adminPassword: app.admin.password,
        superIdentifier: app.superAdmin.identifier,
        superPassword: app.superAdmin.password,
        bootstrapSecret: app.bootstrapSecret,
        setupFromBootstrap: false,
        allowDestructive: true,
      };
      const result = await runWalkthrough(cfg, {
        persona: 'all',
        outDir: dir,
        quiet: true,
      });
      const failed = result.walk.records.filter((r) => r.outcome === 'fail');
      expect(failed.map((r) => `${r.label} ${r.text}: ${r.error}`)).toEqual([]);
      expect(result.uncovered, 'handoff rows with no step').toEqual([]);
      expect(result.ok).toBe(true);

      // every handoff row appears in the summary table with at least one step
      const summary = await readFile(join(dir, 'summary.md'), 'utf8');
      for (const row of COVERAGE_ROWS) {
        const line = summary
          .split('\n')
          .find((l) => l.startsWith(`| ${row.id} |`));
        expect(line, row.id).toBeDefined();
        expect(line).not.toContain('**none**');
      }
      // dropped rows are explicit skips naming the decision
      for (const row of COVERAGE_ROWS.filter((r) => r.kind === 'dropped')) {
        expect(summary).toContain(`skipped by decision ${row.decision}`);
      }
      // one transcript per persona plus summary and JSON results
      const names = await readdir(dir);
      for (const file of [
        'anonymous-visitor.md',
        'viewer.md',
        'member.md',
        'editor.md',
        'community-admin.md',
        'super-admin.md',
        'steward.md',
        'field-kit-operator.md',
        'summary.md',
        'results.json',
      ])
        expect(names).toContain(file);
      const json = JSON.parse(
        await readFile(join(dir, 'results.json'), 'utf8')
      ) as {
        failed: number;
        steps: unknown[];
      };
      expect(json.failed).toBe(0);
      expect(json.steps.length).toBeGreaterThan(300);

      // the real community was only read: byte-identical rows (community,
      // steward, visibility, settings, its admin and recovery-code state)
      expect(await app.snapshotTarget()).toBe(before);
      expect(Object.keys(JSON.parse(before))).toContain('users');
      const real = `/v2/public/communities/${app.community}`;
      for (const r of result.walk.records)
        if (r.method && r.method !== 'GET' && r.path)
          expect(r.path, r.text).not.toContain(real);
      // no login of the real admin without --login-real-admin
      expect(everythingSteps(result.walk.records)).not.toContain('Real admin');

      // cleanup ran and restored: settings put back, play + lab disabled
      const done = (text: string) =>
        result.walk.records.filter(
          (r) => r.outcome === 'pass' && r.text.includes(text)
        );
      // the play community starts with no map configuration: no blank row is written back
      expect(done('puts the map settings back')).toHaveLength(0);
      expect(done('puts the description and the visibility back')).toHaveLength(
        1
      );
      // play, lab and the unclaimed community are all registered and swept
      expect(done('disables the disposable community')).toHaveLength(3);
      expect(result.state.play?.slug).toBe(`${result.runId}-play`);

      // deliberate failed auth attempts stay inside the shared throttle budget
      expect(
        result.walk.records.filter((r) => r.authFailure).length
      ).toBeLessThanOrEqual(5);

      // A08/A09 are only partly covered without --setup-from-bootstrap
      expect(summary).toMatch(/\| A08 \|[^\n]*partially covered/);

      // nothing secret was written
      const everything = await readAll(dir);
      for (const secret of [
        app.admin.password,
        app.superAdmin.password,
        app.bootstrapSecret,
      ])
        expect(everything).not.toContain(secret);
      expect(everything).not.toMatch(/\b[a-f0-9]{64}\b/);
      expect(everything).not.toMatch(/ts_session/);
      expect(everything).not.toMatch(/\$2[aby]\$\d\d\$/);

      // destructive flows ran on the disposable community only
      const steward = await readFile(join(dir, 'steward.md'), 'utf8');
      expect(steward).toContain('/v2/community/erasure');
      expect(everything).not.toContain(app.admin.identifier);
    } finally {
      await app.close();
    }
  }, 240_000);

  it('reports a gated real admin as GATED and never generates recovery codes for it', async () => {
    const app = await startLocalApp();
    try {
      const before = await app.snapshotTarget();
      const dir = await outDir();
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: app.community,
          adminIdentifier: app.admin.identifier,
          adminPassword: app.admin.password,
          superIdentifier: app.superAdmin.identifier,
          superPassword: app.superAdmin.password,
          setupFromBootstrap: false,
          allowDestructive: false,
          loginRealAdmin: true,
        },
        { persona: 'super', outDir: dir, quiet: true }
      );
      expect(result.walk.records.filter((r) => r.outcome === 'fail')).toEqual(
        []
      );
      const gate = result.walk.records.find(
        (r) => r.path === '/v2/stories?limit=1' && r.status === 403
      );
      expect(gate?.outcome).toBe('pass');
      const check = await readFile(
        join(dir, 'migrated-community-check.md'),
        'utf8'
      );
      expect(check).toContain('GATED');
      expect(check).toContain('"admin_media":"gated"');
      expect(
        result.walk.records.some((r) => r.path?.includes('recovery-codes'))
      ).toBe(false);
      // the real admin's recovery-code state is untouched (the login itself
      // upgrades the verifier, which is the one documented write)
      const after = JSON.parse(await app.snapshotTarget()) as {
        login_codes?: unknown[];
      };
      expect(after.login_codes ?? []).toEqual(
        (JSON.parse(before) as { login_codes?: unknown[] }).login_codes ?? []
      );
    } finally {
      await app.close();
    }
  }, 120_000);

  it('defers withdrawal and erasure unless --allow-destructive is given', async () => {
    const app = await startLocalApp();
    try {
      const dir = await outDir();
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: app.community,
          adminIdentifier: app.admin.identifier,
          adminPassword: app.admin.password,
          superIdentifier: app.superAdmin.identifier,
          superPassword: app.superAdmin.password,
          setupFromBootstrap: false,
          allowDestructive: false,
        },
        { persona: 'steward', outDir: dir, quiet: true }
      );
      expect(result.walk.records.filter((r) => r.outcome === 'fail')).toEqual(
        []
      );
      const all = result.walk.records;
      expect(all.some((r) => r.path === '/v2/community/withdrawal')).toBe(
        false
      );
      expect(all.some((r) => r.path === '/v2/community/erasure')).toBe(false);
      expect(all.some((r) => r.outcome === 'skip' && r.deferred)).toBe(true);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('does not pass --persona all when a deferred API row never ran', async () => {
    const app = await startLocalApp();
    try {
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: app.community,
          superIdentifier: app.superAdmin.identifier,
          superPassword: app.superAdmin.password,
          bootstrapSecret: app.bootstrapSecret,
          setupFromBootstrap: false,
          allowDestructive: false,
        },
        { persona: 'all', outDir: await outDir(), quiet: true }
      );
      expect(result.ok).toBe(false);
      for (const id of ['V04', 'V05', 'V06'])
        expect(result.uncovered, id).toContain(id);
    } finally {
      await app.close();
    }
  }, 240_000);

  it('only reads the real community and signs in as its admin only on request', async () => {
    const app = await startLocalApp();
    try {
      const before = JSON.parse(await app.snapshotTarget());
      const dir = await outDir();
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: app.community,
          adminIdentifier: app.admin.identifier,
          adminPassword: app.admin.password,
          superIdentifier: app.superAdmin.identifier,
          superPassword: app.superAdmin.password,
          setupFromBootstrap: false,
          allowDestructive: false,
          loginRealAdmin: true,
        },
        { persona: 'fieldkit', outDir: dir, quiet: true }
      );
      expect(result.walk.records.filter((r) => r.outcome === 'fail')).toEqual(
        []
      );
      const check = await readFile(
        join(dir, 'migrated-community-check.md'),
        'utf8'
      );
      expect(check).toContain('migrated Rails password');
      const after = JSON.parse(await app.snapshotTarget());
      // only the login-upgraded credential columns of the admin may differ
      expect(after.communities).toEqual(before.communities);
      for (const key of Object.keys(before))
        if (key !== 'users' && !/audit/i.test(key))
          expect(after[key], key).toEqual(before[key]);
      expect(after.users).toHaveLength(before.users.length);
      for (const [i, u] of before.users.entries()) {
        const a = after.users[i];
        for (const col of [
          'role',
          'communityId',
          'isActive',
          'username',
          'recoveryCodesConfirmedAt',
        ])
          expect(a[col], col).toEqual(u[col]);
      }
      expect(await readAll(dir)).not.toContain(app.admin.identifier);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('fails clearly and changes nothing without super admin credentials', async () => {
    const app = await startLocalApp();
    try {
      const before = await app.snapshotTarget();
      const dir = await outDir();
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: app.community,
          setupFromBootstrap: false,
          allowDestructive: false,
        },
        { persona: 'all', outDir: dir, quiet: true }
      );
      expect(result.ok).toBe(false);
      expect(result.blocked.join(' ')).toContain('no super admin credentials');
      expect(result.uncovered.length).toBeGreaterThan(0);
      expect(
        result.walk.records.some(
          (r) => r.method && r.method !== 'GET' && r.path !== '/v2/bootstrap'
        )
      ).toBe(false);
      expect(await app.snapshotTarget()).toBe(before);
    } finally {
      await app.close();
    }
  }, 120_000);

  it('sets a fresh install up through the bootstrap screens', async () => {
    const app = await startLocalApp({ fresh: true });
    try {
      const dir = await outDir();
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: 'unused',
          bootstrapSecret: app.bootstrapSecret,
          setupFromBootstrap: true,
          allowDestructive: false,
        },
        { persona: 'fieldkit', outDir: dir, quiet: true }
      );
      expect(result.walk.records.filter((r) => r.outcome === 'fail')).toEqual(
        []
      );
      const coverage = result.walk.coverage();
      for (const id of ['A07', 'A08', 'A09'])
        expect(
          coverage.find((c) => c.row.id === id)?.executed.length,
          id
        ).toBeGreaterThan(0);
      expect(await readAll(dir)).not.toContain(app.bootstrapSecret);
    } finally {
      await app.close();
    }
  }, 120_000);
});

describe('walkthrough safety and options', () => {
  it('starts no new step once an interrupt is pending', async () => {
    const walk = new Walk('http://127.0.0.1:1', { quiet: true });
    walk.stopping = true;
    await expect(
      walk.step({
        who: walk.actor('X', 'anonymous visitor'),
        say: 'x',
        method: 'GET',
        path: '/health',
        expect: 200,
      })
    ).rejects.toThrow(/interrupted/);
    expect(walk.records).toEqual([]);
  });

  it('records the server commit timestamp as serverAt on an import commit step', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ data: { committedAt: '2026-01-01T23:59:59.900Z' } })
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const walk = new Walk(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        { quiet: true }
      );
      walk.chapter('Steward', 'import');
      await walk.step({
        who: walk.actor('X', 'steward'),
        say: 'commit',
        method: 'POST',
        path: '/v2/imports/7/commit',
        expect: 200,
      });
      const rec = JSON.parse(JSON.stringify(walk.records[0]));
      expect(rec.serverAt).toBe('2026-01-01T23:59:59.900Z');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('never sends a Secure cookie over plain HTTP except to localhost', () => {
    const jar = new CookieJar();
    jar.absorb(
      new Headers([
        ['set-cookie', 'ts_session=abc123; Path=/; HttpOnly; Secure'],
      ])
    );
    expect(() => jar.header(new URL('http://staging.example/v2'))).toThrow(
      /Secure cookie/
    );
    expect(jar.header(new URL('https://staging.example/v2'))).toContain(
      'ts_session=abc123'
    );
    expect(jar.header(new URL('http://127.0.0.1:8787/v2'))).toContain(
      'ts_session=abc123'
    );
  });

  it('refuses destructive steps on any community that is not the run-prefixed disposable one', async () => {
    const walk = new Walk('http://127.0.0.1:1', { quiet: true });
    const s = newState();
    s.lab = { id: 1, slug: 'barbara', name: 'barbara' };
    await stewardChapter({
      w: walk,
      s,
      cfg: {
        baseUrl: 'http://127.0.0.1:1',
        community: 'barbara',
        setupFromBootstrap: false,
        allowDestructive: true,
      },
    });
    expect(walk.failed).toBe(true);
    expect(walk.records.filter((r) => r.path)).toEqual([]);
  });

  it('parses options and validates personas', () => {
    expect(
      parseArgs(['--base-url', 'http://x', '--persona', 'viewer']).persona
    ).toBe('viewer');
    expect(parseArgs(['--base-url', 'http://x']).workersPlan).toBe('free');
    expect(
      parseArgs(['--base-url', 'http://x', '--workers-plan', 'paid'])
        .workersPlan
    ).toBe('paid');
    expect(
      parseArgs(['--base-url', 'http://x', '--workers-plan', 'free'])
        .workersPlan
    ).toBe('free');
    expect(() =>
      parseArgs(['--base-url', 'http://x', '--workers-plan', 'pro'])
    ).toThrow(/--workers-plan/);
    expect(parseArgs(['--admin-credentials-env']).adminEnv).toBe('WT_ADMIN');
    expect(
      parseArgs(['--admin-credentials-env', 'MINE', '--allow-destructive'])
    ).toMatchObject({
      adminEnv: 'MINE',
      allowDestructive: true,
    });
    expect(() => parseArgs(['--persona', 'nobody'])).toThrow();
    expect(() => parseArgs(['--nope'])).toThrow();
    expect([...selectPersonas('viewer')].sort()).toEqual([
      'admin',
      'anonymous',
      'editor',
      'member',
      'viewer',
    ]);
    expect([...selectPersonas('steward')].sort()).toEqual(['steward', 'super']);
    expect(selectPersonas('all').size).toBe(8);
  });

  it('skips Free-only D1 daily-import 429 assertions with a note when --workers-plan paid is set', async () => {
    const app = await startLocalApp();
    try {
      const dir = await outDir();
      const lines: string[] = [];
      const result = await runWalkthrough(
        {
          baseUrl: app.baseUrl,
          community: app.community,
          superIdentifier: app.superAdmin.identifier,
          superPassword: app.superAdmin.password,
          setupFromBootstrap: false,
          allowDestructive: false,
          d1: true,
          workersPlan: 'paid',
        },
        {
          persona: 'editor',
          outDir: dir,
          quiet: true,
          onLine: (line) => lines.push(line),
        }
      );
      expect(result.walk.records.filter((r) => r.outcome === 'fail')).toEqual(
        []
      );
      expect(
        result.walk.records.filter(
          (r) => r.negative && r.expected?.includes(429)
        )
      ).toEqual([]);
      const skip = result.walk.records.find(
        (r) => r.outcome === 'skip' && r.note?.includes('not plan-switched yet')
      );
      expect(skip).toBeDefined();
      expect(lines.join('\n')).toContain('SKIPPED');
      expect(lines.join('\n')).toContain('--workers-plan paid');
    } finally {
      await app.close();
    }
  }, 120_000);

  it('lists every row of handoff sections 4 and 5', () => {
    expect(COVERAGE_ROWS).toHaveLength(89);
    expect(new Set(COVERAGE_ROWS.map((r) => r.id)).size).toBe(89);
    for (const id of ['A01', 'M13', 'B14', 'C32', 'D08', 'S08', 'V21'])
      expect(COVERAGE_ROWS.some((r) => r.id === id)).toBe(true);
  });
});
