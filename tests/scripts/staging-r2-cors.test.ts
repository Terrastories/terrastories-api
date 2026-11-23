/**
 * R2 CORS and lifecycle for the staging kit: the guards that read wrangler's
 * answer back, provision.sh applying them under --apply (fake wrangler, no
 * account, no network), and the browser preflight check (fake curl).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORS_ORIGIN_PLACEHOLDER,
  GuardError,
  PART_UPLOAD_HEADER,
  assertCorsFile,
  assertCorsPolicyAllowsUploads,
  assertCorsPreflight,
  assertFrontendOrigin,
  assertLifecycleAbortRule,
} from '../../scripts/staging/guards.js';

const ROOT = resolve(__dirname, '../..');
const ACCOUNT = 'a'.repeat(32);
const ORIGIN = 'https://app.terrastories.test';
const BUCKET = 'terrastories-staging-media';
const RENDERED = join(ROOT, 'scripts/staging/.r2-cors.json');
const RULE = 'terrastories-staging-abort-incomplete-multipart';

/** `wrangler r2 bucket cors list`: labelled, column-aligned, one rule a block. */
const CORS_LIST_OK = `Listing CORS rules for bucket '${BUCKET}'...

allowed_origins:    ${ORIGIN}
allowed_methods:    PUT
allowed_headers:    ${PART_UPLOAD_HEADER}, content-type
exposed_headers:    ETag
max_age_seconds:    3600
`;

const CORS_LIST_NO_HEADER = `Listing CORS rules for bucket '${BUCKET}'...

allowed_origins:    ${ORIGIN}
allowed_methods:    PUT
allowed_headers:    content-type
exposed_headers:    ETag
max_age_seconds:    3600
`;

const LIFECYCLE_LIST_OK = `Listing lifecycle rules for bucket '${BUCKET}'...

name:     ${RULE}
enabled:  Yes
prefix:   (all prefixes)
action:   Abort incomplete multipart uploads after 1 days
`;

const LIFECYCLE_LIST_NONE = `There are no lifecycle rules for bucket '${BUCKET}'.`;

const LIFECYCLE_LIST_EXPIRE_ONLY = `Listing lifecycle rules for bucket '${BUCKET}'...

name:     terrastories-staging-expire
enabled:  Yes
prefix:   (all prefixes)
action:   Expire objects after 30 days
`;

/** `curl -i` against the S3 endpoint: CRLF headers, empty body. */
const PREFLIGHT_OK = [
  'HTTP/2 200',
  `access-control-allow-origin: ${ORIGIN}`,
  'access-control-allow-methods: PUT, GET, HEAD',
  `access-control-allow-headers: ${PART_UPLOAD_HEADER}, content-type`,
  'access-control-expose-headers: ETag',
  'access-control-max-age: 3600',
  'content-length: 0',
  '',
  '',
].join('\r\n');

describe('frontend origin guard', () => {
  it('accepts bare http(s) origins', () => {
    for (const ok of [
      'https://app.terrastories.test',
      'https://terrastories-staging-app.x.workers.dev',
      'https://app.terrastories.test:8443',
      'http://localhost:5173',
    ]) {
      expect(() => assertFrontendOrigin(ok), ok).not.toThrow();
    }
  });

  it('refuses anything that is not a bare origin', () => {
    for (const bad of [
      '',
      '*',
      'app.terrastories.test',
      'https://',
      'https://app.terrastories.test/',
      'https://APP.terrastories.test',
      'https://app.terrastories.test:443',
      'https://app.terrastories.test/admin',
      'https://app.terrastories.test/?next=1',
      'https://app.terrastories.test/#x',
      'ftp://app.terrastories.test',
      CORS_ORIGIN_PLACEHOLDER,
    ]) {
      expect(() => assertFrontendOrigin(bad), bad).toThrow(GuardError);
    }
  });
});

describe('the CORS file wrangler is given', () => {
  const work = mkdtempSync(join(tmpdir(), 'cors-file-'));
  const file = join(work, 'r2-cors.json');
  const template = join(ROOT, 'scripts/staging/r2-cors.json');
  const write = (config: unknown) => {
    writeFileSync(file, JSON.stringify(config));
    return file;
  };
  const rule = (over: Record<string, unknown> = {}) => ({
    rules: [
      {
        allowed: {
          origins: [ORIGIN],
          methods: ['PUT'],
          headers: [PART_UPLOAD_HEADER, 'content-type'],
          ...((over.allowed as object) ?? {}),
        },
        exposeHeaders: (over.exposeHeaders as string[]) ?? ['ETag'],
        maxAgeSeconds: (over.maxAgeSeconds as number) ?? 3600,
      },
    ],
  });

  it('accepts the committed template once the origin is substituted', () => {
    expect(() => assertCorsFile(template)).not.toThrow();
    expect(() => assertCorsFile(template, ORIGIN)).toThrow(
      /does not allow the origin/
    );
    writeFileSync(
      file,
      readFileSync(template, 'utf8').split(CORS_ORIGIN_PLACEHOLDER).join(ORIGIN)
    );
    expect(() => assertCorsFile(file, ORIGIN)).not.toThrow();
    // the file really carries the operator's origin, not the placeholder
    expect(readFileSync(file, 'utf8')).toContain(ORIGIN);
    expect(readFileSync(file, 'utf8')).not.toContain(CORS_ORIGIN_PLACEHOLDER);
  });

  it('refuses a config that drops the part-upload contract', () => {
    expect(() =>
      assertCorsFile(
        write(rule({ allowed: { headers: ['content-type'] } })),
        ORIGIN
      )
    ).toThrow(/PUT with/);
    expect(() =>
      assertCorsFile(write(rule({ allowed: { methods: ['GET'] } })), ORIGIN)
    ).toThrow(/PUT with/);
    expect(() =>
      assertCorsFile(write(rule({ maxAgeSeconds: 60 })), ORIGIN)
    ).toThrow(/maxAgeSeconds/);
    expect(() =>
      assertCorsFile(write(rule({ exposeHeaders: [] })), ORIGIN)
    ).toThrow(/expose ETag/);
    expect(() => assertCorsFile(write({ CORSRules: [] }), ORIGIN)).toThrow(
      /rules array/
    );
    writeFileSync(file, '{ not json');
    expect(() => assertCorsFile(file)).toThrow(/not valid JSON/);
  });
});

describe('wrangler list read-back', () => {
  it('accepts the part-upload rule, plain or coloured', () => {
    expect(() =>
      assertCorsPolicyAllowsUploads(CORS_LIST_OK, ORIGIN)
    ).not.toThrow();
    const coloured = CORS_LIST_OK.replace(/PUT/g, '\x1b[32mPUT\x1b[39m');
    expect(() => assertCorsPolicyAllowsUploads(coloured, ORIGIN)).not.toThrow();
  });

  it('refuses a policy that cannot send the part header', () => {
    expect(() =>
      assertCorsPolicyAllowsUploads(CORS_LIST_NO_HEADER, ORIGIN)
    ).toThrow(/no rule for exactly the origin/);
    expect(() =>
      assertCorsPolicyAllowsUploads(
        `There is no CORS configuration defined for bucket '${BUCKET}'.`,
        ORIGIN
      )
    ).toThrow(/no rule for exactly the origin/);
    expect(() => assertCorsPolicyAllowsUploads('', ORIGIN)).toThrow(
      /no rule for exactly the origin/
    );
  });

  it('refuses a policy that is not exactly the configured origin, ETag and max age', () => {
    const bad = [
      CORS_LIST_OK.replace(ORIGIN, '*'),
      CORS_LIST_OK.replace(ORIGIN, 'https://elsewhere.test'),
      CORS_LIST_OK.replace(ORIGIN, `${ORIGIN}, https://elsewhere.test`),
      CORS_LIST_OK.replace(
        'allowed_methods:    PUT',
        'allowed_methods:    GET'
      ),
      CORS_LIST_OK.replace(
        'exposed_headers:    ETag',
        'exposed_headers:    x-other'
      ),
      CORS_LIST_OK.replace(
        'max_age_seconds:    3600',
        'max_age_seconds:    60'
      ),
      CORS_LIST_OK.replace('max_age_seconds:    3600\n', ''),
    ];
    for (const list of bad) {
      expect(() => assertCorsPolicyAllowsUploads(list, ORIGIN), list).toThrow(
        GuardError
      );
    }
    expect(() =>
      assertCorsPolicyAllowsUploads(
        CORS_LIST_OK.replace('ETag', 'etag').replace('3600', '7200'),
        ORIGIN.toUpperCase().replace('HTTPS', 'https')
      )
    ).not.toThrow();
  });

  it('refuses an abort rule scoped to a prefix or whose day count belongs to another action', () => {
    for (const list of [
      LIFECYCLE_LIST_OK.replace('(all prefixes)', 'uploads/'),
      LIFECYCLE_LIST_OK.replace(
        'Abort incomplete multipart uploads after 1 days',
        'Abort incomplete multipart uploads after 7 days, expire objects after 1 day'
      ),
      LIFECYCLE_LIST_OK.replace(
        'Abort incomplete multipart uploads after 1 days',
        'Expire objects after 1 day, abort incomplete multipart uploads after 7 days'
      ),
      LIFECYCLE_LIST_OK.replace('after 1 days', 'after 10 days'),
    ]) {
      expect(() => assertLifecycleAbortRule(list, 1), list).toThrow(
        /no enabled lifecycle rule/
      );
    }
    expect(() =>
      assertLifecycleAbortRule(
        LIFECYCLE_LIST_OK.replace('(all prefixes)', ''),
        1
      )
    ).not.toThrow();
  });

  it('requires an enabled abort rule at the configured age', () => {
    expect(() => assertLifecycleAbortRule(LIFECYCLE_LIST_OK, 1)).not.toThrow();
    expect(() => assertLifecycleAbortRule(LIFECYCLE_LIST_OK, 7)).toThrow(
      /after 7 day/
    );
    expect(() => assertLifecycleAbortRule(LIFECYCLE_LIST_NONE, 1)).toThrow(
      /no enabled lifecycle rule/
    );
    expect(() =>
      assertLifecycleAbortRule(LIFECYCLE_LIST_EXPIRE_ONLY, 1)
    ).toThrow(/no enabled lifecycle rule/);
    expect(() =>
      assertLifecycleAbortRule(
        LIFECYCLE_LIST_OK.replace('enabled:  Yes', 'enabled:  No'),
        1
      )
    ).toThrow(/no enabled lifecycle rule/);
    expect(() => assertLifecycleAbortRule(LIFECYCLE_LIST_OK, 0)).toThrow(
      /positive integer/
    );
  });
});

describe('the browser preflight answer', () => {
  it('accepts an answer that allows the part PUT', () => {
    expect(() => assertCorsPreflight(ORIGIN, PREFLIGHT_OK)).not.toThrow();
    expect(() =>
      assertCorsPreflight(ORIGIN, PREFLIGHT_OK.replace(ORIGIN, '*'))
    ).not.toThrow();
  });

  it('refuses a comma-separated Access-Control-Allow-Origin list', () => {
    for (const value of [
      `${ORIGIN}, https://elsewhere.test`,
      `https://elsewhere.test,${ORIGIN}`,
      `${ORIGIN}, *`,
    ]) {
      expect(() =>
        assertCorsPreflight(
          ORIGIN,
          PREFLIGHT_OK.replace(
            `access-control-allow-origin: ${ORIGIN}`,
            `access-control-allow-origin: ${value}`
          )
        )
      ).toThrow(GuardError);
    }
  });

  it('refuses answers that do not allow it', () => {
    const bad = [
      PREFLIGHT_OK.replace(
        `access-control-allow-headers: ${PART_UPLOAD_HEADER}, content-type`,
        'access-control-allow-headers: content-type'
      ),
      PREFLIGHT_OK.replace(
        'access-control-allow-methods: PUT, GET, HEAD',
        'access-control-allow-methods: GET'
      ),
      PREFLIGHT_OK.replace(
        `access-control-allow-origin: ${ORIGIN}`,
        'access-control-allow-origin: https://elsewhere.test'
      ),
      'HTTP/2 403\r\ncontent-length: 0\r\n\r\n',
      '',
    ];
    for (const response of bad) {
      expect(() => assertCorsPreflight(ORIGIN, response), response).toThrow(
        GuardError
      );
    }
  });

  it('reads the header block only, never the body', () => {
    const spoofed =
      'HTTP/2 403\r\ncontent-type: application/xml\r\n\r\n<Error><Code>AccessForbidden</Code></Error>' +
      `\r\naccess-control-allow-origin: ${ORIGIN}` +
      `\r\naccess-control-allow-methods: PUT` +
      `\r\naccess-control-allow-headers: ${PART_UPLOAD_HEADER}`;
    expect(() => assertCorsPreflight(ORIGIN, spoofed)).toThrow(GuardError);
  });
});

// Fake wrangler and fake curl: no account, no network. The wrangler fake only
// logs and answers the read-backs provision.sh asks for.
const work = mkdtempSync(join(tmpdir(), 'staging-r2-cors-'));
const bin = join(work, 'bin');
mkdirSync(bin);
const npxLog = join(work, 'npx.log');
const curlLog = join(work, 'curl.log');
const corsListFile = join(work, 'cors-list.txt');
const lifecycleListFile = join(work, 'lifecycle-list.txt');
const preflightFile = join(work, 'preflight.txt');
const lifecycleAfterFile = join(work, 'lifecycle-after-add.txt');
writeFileSync(lifecycleAfterFile, LIFECYCLE_LIST_OK);

writeFileSync(
  join(bin, 'npx'),
  `#!/usr/bin/env bash
echo "$@" >> "${npxLog}"
case "$*" in
  *whoami*) echo "Account ${ACCOUNT}" ;;
  *"d1 list"*) echo "[]" ;;
  *"r2 bucket list"*) echo "name: ${BUCKET}" ;;
  *"r2 bucket cors list"*) cat "${corsListFile}" ;;
  *"r2 bucket lifecycle list"*)
    if grep -q "lifecycle add" "${npxLog}"; then cat "${lifecycleAfterFile}"; else cat "${lifecycleListFile}"; fi ;;
  *tsx*) shift; shift; exec "${ROOT}/node_modules/.bin/tsx" "$@" ;;
esac
`
);
writeFileSync(
  join(bin, 'curl'),
  `#!/usr/bin/env bash
echo "$@" >> "${curlLog}"
cat "$FAKE_PREFLIGHT"
`
);
chmodSync(join(bin, 'npx'), 0o755);
chmodSync(join(bin, 'curl'), 0o755);

const runKit = (
  script: string,
  args: string[],
  extra: Record<string, string> = {}
) =>
  spawnSync('bash', [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_PREFLIGHT: preflightFile,
      ...extra,
    },
  });

const calls = () => {
  rmSync(npxLog, { force: true });
  rmSync(curlLog, { force: true });
  return {
    npx: () => (existsSync(npxLog) ? readFileSync(npxLog, 'utf8') : ''),
    curl: () => (existsSync(curlLog) ? readFileSync(curlLog, 'utf8') : ''),
  };
};

describe('provision.sh applies and verifies the bucket config', () => {
  const base = {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    STAGING_FRONTEND_ORIGIN: ORIGIN,
  };
  const provision = (extra: Record<string, string>, args: string[] = []) =>
    runKit('scripts/staging/provision.sh', args, { ...base, ...extra });

  it('refuses without the frontend origin', () => {
    const logs = calls();
    const r = runKit('scripts/staging/provision.sh', [], {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/STAGING_FRONTEND_ORIGIN/);
    expect(logs.npx()).not.toContain('cors set');
  });

  it('dry run prints the CORS and lifecycle commands and runs neither', () => {
    const logs = calls();
    writeFileSync(corsListFile, '');
    writeFileSync(lifecycleListFile, LIFECYCLE_LIST_NONE);
    const r = provision({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      `+ npx wrangler r2 bucket cors set ${BUCKET} --file ${RENDERED} -y`
    );
    expect(r.stdout).toContain(
      `+ npx wrangler r2 bucket lifecycle add ${BUCKET} ${RULE} --abort-multipart-days 1 -y`
    );
    const npx = logs.npx();
    expect(npx).not.toContain('cors set');
    expect(npx).not.toContain('lifecycle add');
    // the rendered file is the committed template with the origin in it
    expect(readFileSync(RENDERED, 'utf8')).toContain(ORIGIN);
    expect(readFileSync(RENDERED, 'utf8')).not.toContain(
      CORS_ORIGIN_PLACEHOLDER
    );
  });

  it('applies CORS, then reads it back and refuses a policy without the header', () => {
    const logs = calls();
    writeFileSync(corsListFile, CORS_LIST_NO_HEADER);
    writeFileSync(lifecycleListFile, LIFECYCLE_LIST_NONE);
    const r = provision({}, ['--apply']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no rule for exactly the origin/);
    const npx = logs.npx();
    expect(npx).toContain(`r2 bucket cors set ${BUCKET} --file ${RENDERED} -y`);
    expect(npx).toContain('r2 bucket cors list');
    // fail closed: nothing else is touched once the read-back refuses
    expect(npx).not.toContain('lifecycle add');
  });

  it('applies and verifies CORS and the missing lifecycle rule', () => {
    const logs = calls();
    writeFileSync(corsListFile, CORS_LIST_OK);
    writeFileSync(lifecycleListFile, LIFECYCLE_LIST_NONE);
    const r = provision({}, ['--apply']);
    expect(r.status, r.stderr).toBe(0);
    const npx = logs.npx();
    expect(npx).toContain(`r2 bucket cors set ${BUCKET} --file ${RENDERED} -y`);
    expect(npx).toContain(
      `r2 bucket lifecycle add ${BUCKET} ${RULE} --abort-multipart-days 1 -y`
    );
    // the added rule is read back before the script passes
    expect(
      npx.match(/r2 bucket lifecycle list/g)?.length ?? 0
    ).toBeGreaterThanOrEqual(2);
    expect(r.stdout).toContain('R2 CORS verified');
    expect(r.stdout).toContain('added and verified');
  });

  it('does not re-add a lifecycle rule that is already in effect', () => {
    const logs = calls();
    writeFileSync(corsListFile, CORS_LIST_OK);
    writeFileSync(lifecycleListFile, LIFECYCLE_LIST_OK);
    const r = provision({}, ['--apply']);
    expect(r.status, r.stderr).toBe(0);
    const npx = logs.npx();
    expect(npx).toContain('r2 bucket cors set');
    expect(npx).not.toContain('lifecycle add');
    expect(npx.match(/r2 bucket lifecycle list/g)?.length).toBe(1);
    expect(r.stdout).toContain('R2 lifecycle verified');
  });
});

describe('cors-preflight.sh (fake curl)', () => {
  const preflight = (extra: Record<string, string>, args: string[] = []) =>
    runKit('scripts/staging/cors-preflight.sh', args, extra);

  it('dry run prints the curl command and sends nothing', () => {
    const logs = calls();
    const r = preflight({});
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('curl -sS -i -X OPTIONS');
    expect(r.stdout).toContain(`Origin: $STAGING_FRONTEND_ORIGIN`);
    expect(r.stdout).toContain(PART_UPLOAD_HEADER);
    expect(logs.curl()).toBe('');
  });

  it('passes when the answer allows the part PUT from the origin', () => {
    const logs = calls();
    writeFileSync(preflightFile, PREFLIGHT_OK);
    const r = preflight(
      {
        STAGING_FRONTEND_ORIGIN: ORIGIN,
        R2_ACCOUNT_ID: ACCOUNT,
        R2_BUCKET_NAME: BUCKET,
      },
      ['--apply']
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('CORS preflight allowed');
    const curl = logs.curl();
    expect(curl).toContain('-X OPTIONS');
    expect(curl).toContain(`Origin: ${ORIGIN}`);
    expect(curl).toContain(`Access-Control-Request-Method: PUT`);
    expect(curl).toContain(PART_UPLOAD_HEADER);
    expect(curl).toContain(
      `https://${ACCOUNT}.r2.cloudflarestorage.com/${BUCKET}`
    );
  });

  it('fails when the answer does not allow the part PUT', () => {
    const logs = calls();
    writeFileSync(
      preflightFile,
      PREFLIGHT_OK.replace(
        `access-control-allow-headers: ${PART_UPLOAD_HEADER}, content-type`,
        'access-control-allow-headers: content-type'
      )
    );
    const r = preflight(
      {
        STAGING_FRONTEND_ORIGIN: ORIGIN,
        R2_ACCOUNT_ID: ACCOUNT,
        R2_BUCKET_NAME: BUCKET,
      },
      ['--apply']
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refused/);
    expect(logs.curl()).toContain('-X OPTIONS');
  });

  it('refuses a missing origin, a foreign account and a non-staging bucket', () => {
    calls();
    const noOrigin = preflight(
      { R2_ACCOUNT_ID: ACCOUNT, R2_BUCKET_NAME: BUCKET },
      ['--apply']
    );
    expect(noOrigin.status).not.toBe(0);
    expect(noOrigin.stderr).toMatch(/STAGING_FRONTEND_ORIGIN/);

    const foreign = preflight(
      {
        STAGING_FRONTEND_ORIGIN: ORIGIN,
        R2_ACCOUNT_ID: 'b'.repeat(32),
        R2_BUCKET_NAME: BUCKET,
        CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      },
      ['--apply']
    );
    expect(foreign.status).not.toBe(0);
    expect(foreign.stderr).toMatch(/does not match CLOUDFLARE_ACCOUNT_ID/);

    const notStaging = preflight(
      {
        STAGING_FRONTEND_ORIGIN: ORIGIN,
        R2_ACCOUNT_ID: ACCOUNT,
        R2_BUCKET_NAME: 'terrastories-media',
      },
      ['--apply']
    );
    expect(notStaging.status).not.toBe(0);
    expect(notStaging.stderr).toMatch(/refused/);
  });
});

describe('smoke.sh runs the preflight', () => {
  it('calls cors-preflight.sh as a step', () => {
    const smoke = readFileSync(join(ROOT, 'scripts/staging/smoke.sh'), 'utf8');
    expect(smoke).toContain('cors-preflight.sh');
    expect(smoke).toContain('--apply');
  });
});
