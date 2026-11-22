/**
 * Human-followable persona walkthroughs against a running V2 API.
 *
 *   npm run walkthrough -- --base-url <url> [--community <slug>] \
 *     [--persona <name>|all] [--out <dir>] \
 *     [--setup-from-bootstrap | --admin-credentials-env [PREFIX]] \
 *     [--super-credentials-env [PREFIX]] [--allow-destructive] [--local]
 *
 * Credentials come from the environment (PREFIX_IDENTIFIER, PREFIX_PASSWORD)
 * and are never printed. See docs/WALKTHROUGHS.md.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { newState, type Config, type Ctx, type State } from './context.js';
import { Walk } from './walk.js';
import { COVERAGE_ROWS } from './coverage.js';
import { defineAccounts, adminOpening } from './chapters/admin-opening.js';
import { editorChapter } from './chapters/editor.js';
import { viewerChapter } from './chapters/viewer.js';
import { memberChapter } from './chapters/member.js';
import { anonymousChapter } from './chapters/anonymous.js';
import { adminLateChapter } from './chapters/admin-late.js';
import { provisionPlay, superAdminChapter } from './chapters/super-admin.js';
import { stewardChapter } from './chapters/steward.js';
import { fieldKitChapter } from './chapters/field-kit.js';
import { targetCheckChapter } from './chapters/target-check.js';
import { cleanupChapter } from './chapters/cleanup.js';

export const PERSONAS = [
  'anonymous',
  'viewer',
  'member',
  'editor',
  'admin',
  'super',
  'steward',
  'fieldkit',
] as const;
export type PersonaName = (typeof PERSONAS)[number];

const NEEDS: Record<PersonaName, PersonaName[]> = {
  anonymous: ['admin', 'editor'],
  viewer: ['admin', 'editor'],
  member: ['admin', 'editor'],
  editor: ['admin'],
  admin: ['editor', 'viewer', 'member', 'anonymous'],
  super: [],
  steward: ['super'],
  fieldkit: [],
};

export interface RunOptions {
  persona: PersonaName | 'all';
  outDir: string;
  quiet?: boolean;
  onLine?: (line: string) => void;
  /** Pause between deliberate failed auth attempts (ms). */
  authSpacingMs?: number;
  /** Run cleanup on SIGINT/SIGTERM, then exit (CLI only). */
  handleSignals?: boolean;
}

export interface RunResult {
  ok: boolean;
  runId: string;
  failures: number;
  uncovered: string[];
  /** Reasons a requested part of the run could not happen. */
  blocked: string[];
  coverageEnforced: boolean;
  ran: PersonaName[];
  walk: Walk;
  state: State;
}

export function selectPersonas(persona: PersonaName | 'all'): Set<PersonaName> {
  if (persona === 'all') return new Set(PERSONAS);
  const picked = new Set<PersonaName>([persona]);
  for (const need of NEEDS[persona]) {
    picked.add(need);
    for (const deeper of NEEDS[need]) picked.add(deeper);
  }
  return picked;
}

const CONTENT_PERSONAS: PersonaName[] = [
  'admin',
  'editor',
  'viewer',
  'member',
  'anonymous',
];

export async function runWalkthrough(
  cfg: Config,
  options: RunOptions
): Promise<RunResult> {
  const walk = new Walk(cfg.baseUrl, {
    quiet: options.quiet,
    onLine: options.onLine,
    authSpacingMs: options.authSpacingMs,
  });
  walk.secret(cfg.adminPassword);
  walk.secret(cfg.adminIdentifier);
  walk.secret(cfg.superPassword);
  walk.secret(cfg.bootstrapSecret);
  const ctx: Ctx = { w: walk, cfg, s: newState() };
  defineAccounts(ctx);
  const picked = selectPersonas(options.persona);
  const hasSuper = Boolean(cfg.superIdentifier && cfg.superPassword);
  const blocked: string[] = [];

  let cleanup: Promise<void> | undefined;
  const runCleanup = (): Promise<void> => (cleanup ??= cleanupChapter(ctx));
  const enforced = options.persona === 'all';
  const meta = {
    baseUrl: cfg.baseUrl,
    community: cfg.community,
    persona: options.persona,
    coverageEnforced: enforced,
    allowDestructive: cfg.allowDestructive,
    setupFromBootstrap: cfg.setupFromBootstrap,
    loginRealAdmin: Boolean(cfg.loginRealAdmin),
  };
  let running: Promise<void> | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    // stop new steps, let the request in flight record its result (a created
    // community must have its id saved), and only then clean up
    walk.stopping = true;
    void (running ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => {
        walk.stopping = false;
        walk.narrate(`${signal} received: running cleanup before exit`);
        return runCleanup();
      })
      .catch(() => undefined)
      .then(() => walk.write(options.outDir, meta))
      .catch(() => undefined)
      .then(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  if (options.handleSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  const body = async (): Promise<void> => {
    if (!cfg.setupFromBootstrap) await targetCheckChapter(ctx);
    const needsPlay = CONTENT_PERSONAS.some((p) => picked.has(p));
    const needsSuper =
      needsPlay || picked.has('super') || picked.has('steward');
    if (cfg.setupFromBootstrap) {
      await fieldKitChapter(ctx, 'first');
    } else if (needsSuper && !hasSuper) {
      const names = [...picked].filter(
        (p) => CONTENT_PERSONAS.includes(p) || p === 'super' || p === 'steward'
      );
      walk.chapter(
        'Super admin',
        'Super admin credentials are missing',
        'Every chapter that changes something runs in a disposable community that only a super admin can create.'
      );
      walk.narrate(
        `No super admin credentials (--super-credentials-env), so these personas did NOT run: ${names.join(', ')}. The real community was only read. Uncovered handoff rows are listed in summary.md; the run fails.`
      );
      blocked.push(
        `personas not run (no super admin credentials): ${names.join(', ')}`
      );
      walk.failed = true;
    } else if (needsPlay) {
      await provisionPlay(ctx);
    }
    const canRun = Boolean(ctx.s.play);
    const runContent = canRun && needsPlay;
    if (
      picked.has('admin') ||
      picked.has('editor') ||
      picked.has('viewer') ||
      picked.has('member') ||
      picked.has('anonymous')
    ) {
      if (runContent) await adminOpening(ctx);
    }
    if (runContent && picked.has('editor')) await editorChapter(ctx);
    if (runContent && picked.has('viewer')) await viewerChapter(ctx);
    if (runContent && picked.has('member')) await memberChapter(ctx);
    if (runContent && picked.has('anonymous')) await anonymousChapter(ctx);
    if (runContent && picked.has('admin')) await adminLateChapter(ctx);
    if (needsPlay && !canRun && hasSuper) {
      blocked.push('the play community could not be provisioned');
      walk.failed = true;
    }
    if ((picked.has('super') || picked.has('steward')) && hasSuper) {
      await superAdminChapter(ctx);
      if (picked.has('steward')) await stewardChapter(ctx);
    }
    if (picked.has('fieldkit') && !cfg.setupFromBootstrap)
      await fieldKitChapter(ctx, 'late');
  };
  try {
    running = body();
    await running;
  } finally {
    await runCleanup();
    if (options.handleSignals) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }

  const { uncovered, failures } = await walk.write(options.outDir, meta);
  const missing = enforced || blocked.length ? uncovered : [];
  return {
    ok:
      failures === 0 &&
      !walk.failed &&
      missing.length === 0 &&
      blocked.length === 0,
    runId: walk.runId,
    failures,
    uncovered,
    blocked,
    coverageEnforced: enforced,
    ran: [...picked],
    walk,
    state: ctx.s,
  };
}

interface Parsed {
  baseUrl?: string;
  community: string;
  persona: PersonaName | 'all';
  out: string;
  setupFromBootstrap: boolean;
  adminEnv?: string;
  superEnv?: string;
  allowDestructive: boolean;
  loginRealAdmin: boolean;
  local: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Parsed {
  const parsed: Parsed = {
    community: 'barbara',
    persona: 'all',
    out: 'walkthrough-out',
    setupFromBootstrap: false,
    allowDestructive: false,
    loginRealAdmin: false,
    local: false,
    help: false,
  };
  const optionalValue = (i: number): [string | undefined, number] => {
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? [next, i + 1] : [undefined, i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const need = (): string => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--base-url') parsed.baseUrl = need();
    else if (arg === '--community') parsed.community = need();
    else if (arg === '--persona') {
      const value = need();
      if (value !== 'all' && !(PERSONAS as readonly string[]).includes(value))
        throw new Error(
          `--persona must be all or one of ${PERSONAS.join(', ')}`
        );
      parsed.persona = value as PersonaName | 'all';
    } else if (arg === '--out') parsed.out = need();
    else if (arg === '--setup-from-bootstrap') parsed.setupFromBootstrap = true;
    else if (arg === '--admin-credentials-env') {
      const [value, next] = optionalValue(i);
      parsed.adminEnv = value ?? 'WT_ADMIN';
      i = next;
    } else if (arg === '--super-credentials-env') {
      const [value, next] = optionalValue(i);
      parsed.superEnv = value ?? 'WT_SUPER';
      i = next;
    } else if (arg === '--allow-destructive') parsed.allowDestructive = true;
    else if (arg === '--login-real-admin') parsed.loginRealAdmin = true;
    else if (arg === '--local') parsed.local = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`Unknown argument ${arg}`);
  }
  return parsed;
}

const USAGE = `Usage: npm run walkthrough -- --base-url <url> [options]
  --community <slug>            community to visit (default barbara)
  --persona <name>|all          ${PERSONAS.join(' | ')} (default all)
  --out <dir>                   transcripts, summary.md, results.json (default walkthrough-out)
  --setup-from-bootstrap        fresh install: create the community and admin through /v2/bootstrap
  --admin-credentials-env [P]   real admin: read P_IDENTIFIER and P_PASSWORD (default WT_ADMIN); only used with --login-real-admin
  --login-real-admin            sign in as the real admin for the read-only check (a migrated bcrypt login upgrades the stored verifier to Argon2id)
  --super-credentials-env [P]   read P_IDENTIFIER and P_PASSWORD (default WT_SUPER)
  --allow-destructive           also walk withdrawal and erasure, on a disposable community the script creates
Everything that changes data runs in a disposable community made with the super admin credentials; --community is only read.
  --local                       start an in-process stand-in app instead of --base-url
Bootstrap secret: WT_BOOTSTRAP_SECRET.`;

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  let local:
    | {
        close: () => Promise<void>;
        env: Record<string, string>;
        baseUrl: string;
        community: string;
      }
    | undefined;
  try {
    if (args.local) {
      const { startLocalApp } = await import('./local-app.js');
      local = await startLocalApp({ fresh: args.setupFromBootstrap });
      for (const [k, v] of Object.entries(local.env)) env[k] = v;
      args.baseUrl = local.baseUrl;
      if (!args.setupFromBootstrap) args.community = local.community;
      args.adminEnv ??= args.setupFromBootstrap ? undefined : 'WT_ADMIN';
      args.superEnv ??= args.setupFromBootstrap ? undefined : 'WT_SUPER';
    }
    if (!args.baseUrl) throw new Error('--base-url is required');
    if (args.loginRealAdmin && !args.adminEnv) args.adminEnv = 'WT_ADMIN';
    const cfg: Config = {
      baseUrl: new URL(args.baseUrl).origin,
      community: args.community,
      setupFromBootstrap: args.setupFromBootstrap,
      allowDestructive: args.allowDestructive,
      loginRealAdmin: args.loginRealAdmin,
      // only --setup-from-bootstrap may ever send the secret
      bootstrapSecret: args.setupFromBootstrap
        ? env.WT_BOOTSTRAP_SECRET
        : undefined,
    };
    if (args.adminEnv && !args.setupFromBootstrap) {
      cfg.adminIdentifier = env[`${args.adminEnv}_IDENTIFIER`];
      cfg.adminPassword = env[`${args.adminEnv}_PASSWORD`];
      if (args.loginRealAdmin && (!cfg.adminIdentifier || !cfg.adminPassword))
        throw new Error(
          `set ${args.adminEnv}_IDENTIFIER and ${args.adminEnv}_PASSWORD`
        );
    }
    if (args.superEnv) {
      cfg.superIdentifier = env[`${args.superEnv}_IDENTIFIER`];
      cfg.superPassword = env[`${args.superEnv}_PASSWORD`];
    }
    const result = await runWalkthrough(cfg, {
      persona: args.persona,
      outDir: resolve(args.out),
      authSpacingMs: args.local ? 0 : 3000,
      handleSignals: true,
    });
    process.stdout.write(
      `\nRun ${result.runId}: ${result.ok ? 'PASS' : 'FAIL'}; ${result.failures} failed step(s); ${COVERAGE_ROWS.length - result.uncovered.length}/${COVERAGE_ROWS.length} handoff rows covered${result.uncovered.length ? ' (uncovered: ' + result.uncovered.join(', ') + ')' : ''}${result.blocked.length ? '. BLOCKED: ' + result.blocked.join('; ') : ''}.\nTranscripts: ${resolve(args.out)}\n`
    );
    return result.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`
    );
    return 2;
  } finally {
    await local?.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
