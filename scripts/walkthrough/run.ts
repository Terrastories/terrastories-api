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
import { newState, type Config, type Ctx } from './context.js';
import { Walk } from './walk.js';
import { COVERAGE_ROWS } from './coverage.js';
import { defineAccounts, adminOpening } from './chapters/admin-opening.js';
import { editorChapter } from './chapters/editor.js';
import { viewerChapter } from './chapters/viewer.js';
import { memberChapter } from './chapters/member.js';
import { anonymousChapter } from './chapters/anonymous.js';
import { adminLateChapter } from './chapters/admin-late.js';
import { superAdminChapter } from './chapters/super-admin.js';
import { stewardChapter } from './chapters/steward.js';
import { fieldKitChapter } from './chapters/field-kit.js';
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
}

export interface RunResult {
  ok: boolean;
  runId: string;
  failures: number;
  uncovered: string[];
  coverageEnforced: boolean;
  ran: PersonaName[];
  walk: Walk;
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

export async function runWalkthrough(
  cfg: Config,
  options: RunOptions
): Promise<RunResult> {
  const walk = new Walk(cfg.baseUrl, {
    quiet: options.quiet,
    onLine: options.onLine,
  });
  walk.secret(cfg.adminPassword);
  walk.secret(cfg.superPassword);
  walk.secret(cfg.bootstrapSecret);
  const ctx: Ctx = { w: walk, cfg, s: newState() };
  defineAccounts(ctx);
  const picked = selectPersonas(options.persona);
  const hasSuper = Boolean(cfg.superIdentifier && cfg.superPassword);

  if (cfg.setupFromBootstrap) await fieldKitChapter(ctx, 'first');
  if (
    picked.has('admin') ||
    picked.has('editor') ||
    picked.has('viewer') ||
    picked.has('member') ||
    picked.has('anonymous')
  )
    await adminOpening(ctx);
  if (picked.has('editor')) await editorChapter(ctx);
  if (picked.has('viewer')) await viewerChapter(ctx);
  if (picked.has('member')) await memberChapter(ctx);
  if (picked.has('anonymous')) await anonymousChapter(ctx);
  if (picked.has('admin')) await adminLateChapter(ctx);
  if (picked.has('super') || picked.has('steward')) {
    if (hasSuper) {
      await superAdminChapter(ctx);
      if (picked.has('steward')) await stewardChapter(ctx);
    } else {
      walk.chapter('Super admin', 'Super admin chapters need credentials');
      walk.narrate(
        'No super admin credentials were supplied (--super-credentials-env), so the super admin and steward chapters did not run.'
      );
    }
  }
  if (picked.has('fieldkit') && !cfg.setupFromBootstrap)
    await fieldKitChapter(ctx, 'late');
  await cleanupChapter(ctx);

  const enforced = options.persona === 'all';
  const meta = {
    baseUrl: cfg.baseUrl,
    community: cfg.community,
    persona: options.persona,
    coverageEnforced: enforced,
    allowDestructive: cfg.allowDestructive,
    setupFromBootstrap: cfg.setupFromBootstrap,
  };
  const { uncovered, failures } = await walk.write(options.outDir, meta);
  const missing = enforced ? uncovered : [];
  return {
    ok: failures === 0 && !walk.failed && missing.length === 0,
    runId: walk.runId,
    failures,
    uncovered,
    coverageEnforced: enforced,
    ran: [...picked],
    walk,
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
  --admin-credentials-env [P]   read P_IDENTIFIER and P_PASSWORD (default WT_ADMIN)
  --super-credentials-env [P]   read P_IDENTIFIER and P_PASSWORD (default WT_SUPER)
  --allow-destructive           also walk withdrawal and erasure, on a disposable community the script creates
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
    if (!args.setupFromBootstrap && !args.adminEnv) args.adminEnv = 'WT_ADMIN';
    const cfg: Config = {
      baseUrl: new URL(args.baseUrl).origin,
      community: args.community,
      setupFromBootstrap: args.setupFromBootstrap,
      allowDestructive: args.allowDestructive,
      bootstrapSecret: env.WT_BOOTSTRAP_SECRET,
    };
    if (args.adminEnv && !args.setupFromBootstrap) {
      cfg.adminIdentifier = env[`${args.adminEnv}_IDENTIFIER`];
      cfg.adminPassword = env[`${args.adminEnv}_PASSWORD`];
      if (!cfg.adminIdentifier || !cfg.adminPassword)
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
    });
    process.stdout.write(
      `\nRun ${result.runId}: ${result.ok ? 'PASS' : 'FAIL'}; ${result.failures} failed step(s); ${COVERAGE_ROWS.length - result.uncovered.length}/${COVERAGE_ROWS.length} handoff rows covered${result.uncovered.length ? ' (uncovered: ' + result.uncovered.join(', ') + ')' : ''}.\nTranscripts: ${resolve(args.out)}\n`
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
