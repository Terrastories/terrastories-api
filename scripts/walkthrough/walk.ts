/**
 * The walkthrough recorder: numbered, narrated steps that drive the real HTTP
 * API, plus the per-persona transcripts, the coverage table and the JSON
 * results. A secret registered with secret() is replaced in everything
 * printed or written.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Actor, type CallOptions, type Reply } from './client.js';
import { COVERAGE_ROWS, type CoverageRow } from './coverage.js';

export interface StepSpec extends CallOptions {
  who: Actor;
  /** Plain-language narration, a sentence a human can follow. */
  say: string;
  method: string;
  path: string;
  /** Statuses that count as the expected outcome. */
  expect: number | number[];
  /** Handoff rows (section 4 and 5 ids) this step exercises. */
  covers?: string[];
  /** Rows this step only partly exercises (shown as "partially covered"). */
  partial?: string[];
  /** A deliberate failed login or step-up: counts against the throttle budget and is spaced out. */
  authFailure?: boolean;
  /** A negative check: the API must refuse. Shown as such. */
  negative?: boolean;
  /** What a UI screen would show after this response (key fields). */
  show?: string | string[] | ((reply: Reply) => string[] | string | void);
  /** Extra assertions; return a message to fail the step. */
  check?: (reply: Reply) => string | void;
  /** Override how the request body is displayed. */
  bodyNote?: string;
}

export interface StepRecord {
  label: string;
  chapter: number;
  persona: string;
  actor: string;
  text: string;
  method?: string;
  path?: string;
  status?: number;
  expected?: number[];
  outcome: 'pass' | 'fail' | 'skip';
  negative: boolean;
  covers: string[];
  partial: string[];
  authFailure: boolean;
  ui: string[];
  note?: string;
  /** A skip that stands in for a flow needing an explicit opt-in flag. */
  deferred?: boolean;
  error?: string;
  ms: number;
}

export class StepError extends Error {}

const TICK = '✓';

const MASKED_KEYS = new Set([
  'derivedkey',
  'currentderivedkey',
  'password',
  'token',
  'code',
  'codes',
  'bootstrapsecret',
  'identifier',
  'mapboxaccesstoken',
  'protomapsapikey',
]);

function mask(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => mask(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = MASKED_KEYS.has(key.toLowerCase()) ? '***' : mask(inner);
    }
    return out;
  }
  return value;
}

export class Walk {
  readonly records: StepRecord[] = [];
  readonly runId: string;
  private secrets = new Set<string>();
  private personaLog = new Map<string, string[]>();
  private chapterNo = 0;
  private stepNo = 0;
  private persona = '';
  failed = false;
  /** Set by a signal handler: no further request starts; the one in flight still records its result. */
  stopping = false;
  private lastAuthFailure = 0;

  constructor(
    readonly baseUrl: string,
    readonly options: {
      quiet?: boolean;
      onLine?: (line: string) => void;
      /** Pause before each deliberate failed auth attempt (the server throttles 10 per 15 minutes per IP). */
      authSpacingMs?: number;
    } = {}
  ) {
    this.runId = `wt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  }

  secret(value: string | undefined | null): void {
    if (value && value.length >= 6) this.secrets.add(value);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join('***');
    return out;
  }

  actor(name: string, role: string): Actor {
    return new Actor(this.baseUrl, name, role, (v) => this.secret(v));
  }

  private emit(persona: string, ...lines: string[]): void {
    const log = this.personaLog.get(persona) ?? [];
    for (const line of lines) log.push(this.redact(line));
    this.personaLog.set(persona, log);
  }

  private console(line: string): void {
    const text = this.redact(line);
    if (this.options.onLine) this.options.onLine(text);
    else if (!this.options.quiet) process.stdout.write(text + '\n');
  }

  chapter(persona: string, title: string, intro?: string): number {
    this.chapterNo += 1;
    this.stepNo = 0;
    this.persona = persona;
    if (!this.personaLog.has(persona)) {
      this.emit(persona, `# ${persona}`, '');
    }
    this.emit(persona, `## Chapter ${this.chapterNo}: ${title}`, '');
    if (intro) this.emit(persona, intro, '');
    this.console(`\n== Chapter ${this.chapterNo}: ${title} (${persona}) ==`);
    return this.chapterNo;
  }

  private nextLabel(): string {
    this.stepNo += 1;
    return `${this.chapterNo}.${this.stepNo}`;
  }

  /** Narration without an API call: context a human reader needs. */
  narrate(text: string): void {
    this.emit(this.persona, `_${text}_`, '');
    this.console(`   ${text}`);
  }

  async step(spec: StepSpec): Promise<Reply> {
    if (this.stopping) throw new StepError('interrupted: no further steps');
    const label = this.nextLabel();
    const expected = Array.isArray(spec.expect) ? spec.expect : [spec.expect];
    const started = Date.now();
    const bodyShown =
      spec.bodyNote ??
      (spec.json !== undefined
        ? JSON.stringify(mask(spec.json))
        : spec.form
          ? 'multipart form'
          : spec.rawBody
            ? `raw body (${spec.rawBody.byteLength} bytes) + x-content-sha256`
            : '');
    const record: StepRecord = {
      label,
      chapter: this.chapterNo,
      persona: this.persona,
      actor: `${spec.who.name} (${spec.who.role})`,
      text: spec.say,
      method: spec.method,
      path: this.redact(spec.path),
      expected,
      outcome: 'pass',
      negative: spec.negative === true,
      covers: spec.covers ?? [],
      partial: spec.partial ?? [],
      authFailure: spec.authFailure === true,
      ui: [],
      ms: 0,
    };
    if (spec.authFailure && this.options.authSpacingMs) {
      const wait =
        this.lastAuthFailure + this.options.authSpacingMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    let reply: Reply | undefined;
    let failure: string | undefined;
    try {
      reply = await spec.who.call(spec.method, spec.path, {
        json: spec.json,
        form: spec.form,
        rawBody: spec.rawBody,
        headers: spec.headers,
        noCookie: spec.noCookie,
      });
      record.status = reply.status;
      if (!expected.includes(reply.status)) {
        failure = `expected ${expected.join('/')} but got ${reply.status}${errorHint(reply)}`;
      } else if (spec.check) {
        const message = spec.check(reply);
        if (message) failure = message;
      }
      if (!failure && spec.show) {
        const shown =
          typeof spec.show === 'function' ? spec.show(reply) : spec.show;
        if (typeof shown === 'string') record.ui = [shown];
        else if (Array.isArray(shown)) record.ui = shown;
      }
    } catch (error) {
      failure = `request failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (spec.authFailure) this.lastAuthFailure = Date.now();
    record.ms = Date.now() - started;
    if (failure) {
      record.outcome = 'fail';
      record.error = this.redact(failure);
      this.failed = true;
    }
    record.ui = record.ui.map((u) => this.redact(u));
    this.records.push(record);

    const mark = failure ? 'FAIL' : TICK;
    const kind = spec.negative ? ' (must be refused)' : '';
    const statusText =
      record.status === undefined ? 'no response' : String(record.status);
    this.console(
      `${label} ${spec.who.name} ${spec.say}${kind} -> ${spec.method} ${record.path} -> ${statusText} ${mark}${failure ? ' ' + this.redact(failure) : ''}`
    );
    this.emit(
      this.persona,
      `### ${label} ${spec.who.name} (${spec.who.role}) ${spec.say}`,
      '',
      `- Request: \`${spec.method} ${record.path}\`${bodyShown ? ` with \`${bodyShown}\`` : ''}`,
      `- Result: ${statusText} ${failure ? 'FAILED: ' + failure : TICK}${spec.negative ? ' (negative check: the API refuses this)' : ''}`,
      ...(record.ui.length
        ? ['- A screen would show:', ...record.ui.map((u) => `  - ${u}`)]
        : []),
      ...(record.covers.length
        ? [`- Covers: ${record.covers.join(', ')}`]
        : []),
      ...(record.partial.length
        ? [
            `- Partially covers: ${record.partial.join(', ')} (closed-setup check only)`,
          ]
        : []),
      ''
    );
    if (failure) throw new StepError(`${label}: ${failure}`);
    return reply!;
  }

  /** A step that is not run, with the reason a human can read. */
  skip(
    covers: string[],
    text: string,
    reason: string,
    who?: string,
    deferred = false
  ): void {
    const label = this.nextLabel();
    const record: StepRecord = {
      label,
      chapter: this.chapterNo,
      persona: this.persona,
      actor: who ?? '',
      text,
      outcome: 'skip',
      negative: false,
      covers,
      partial: [],
      authFailure: false,
      ui: [],
      note: reason,
      deferred,
      ms: 0,
    };
    this.records.push(record);
    this.console(`${label} SKIPPED ${text}: ${reason}`);
    this.emit(
      this.persona,
      `### ${label} ${text}`,
      '',
      `- Skipped: ${reason}`,
      `- Covers: ${covers.join(', ')}`,
      ''
    );
  }

  /** Coverage per row: which steps exercised it. */
  coverage(): Array<{
    row: CoverageRow;
    steps: string[];
    executed: string[];
    skipped: string[];
    ok: boolean;
    deferred: boolean;
    partial: boolean;
    partlyDeferred: boolean;
  }> {
    return COVERAGE_ROWS.map((row) => {
      const partialSteps = this.records.filter(
        (r) => r.outcome === 'pass' && r.partial.includes(row.id)
      );
      const steps = this.records.filter((r) => r.covers.includes(row.id));
      const executed = steps
        .filter((r) => r.outcome === 'pass')
        .map((r) => r.label);
      const skipped = steps
        .filter((r) => r.outcome === 'skip')
        .map((r) => r.label);
      const deferred = steps.some((r) => r.outcome === 'skip' && r.deferred);
      const ok =
        row.kind === 'api'
          ? executed.length > 0 || partialSteps.length > 0
          : executed.length + skipped.length > 0;
      return {
        row,
        partlyDeferred: executed.length > 0 && deferred,
        partial: executed.length === 0 && partialSteps.length > 0,
        steps: [...steps, ...partialSteps].map((r) => r.label),
        executed,
        skipped,
        ok,
        deferred: deferred && executed.length === 0,
      };
    });
  }

  async write(
    outDir: string,
    meta: Record<string, unknown>
  ): Promise<{ uncovered: string[]; failures: number }> {
    await mkdir(outDir, { recursive: true });
    for (const [persona, lines] of this.personaLog) {
      const slug = persona.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await writeFile(join(outDir, `${slug}.md`), lines.join('\n') + '\n');
    }
    const coverage = this.coverage();
    const uncovered = coverage.filter((c) => !c.ok).map((c) => c.row.id);
    const failures = this.records.filter((r) => r.outcome === 'fail').length;
    const passed = this.records.filter((r) => r.outcome === 'pass').length;
    const skipped = this.records.filter((r) => r.outcome === 'skip').length;
    const summary = [
      `# Walkthrough summary (${this.runId})`,
      '',
      `- Steps: ${passed} passed, ${failures} failed, ${skipped} skipped`,
      `- Coverage: ${coverage.length - uncovered.length} of ${coverage.length} handoff rows${uncovered.length ? `; UNCOVERED: ${uncovered.join(', ')}` : ''}`,
      '',
      '| Row | Interaction | Kind | Steps |',
      '| --- | --- | --- | --- |',
      ...coverage.map((c) => {
        const kind = c.partlyDeferred
          ? 'API (partially covered: a deferred action was not walked)'
          : c.row.kind === 'dropped'
            ? `skipped by decision ${c.row.decision}`
            : c.row.kind === 'client'
              ? 'client-only'
              : c.deferred
                ? 'API (deferred: needs --allow-destructive)'
                : c.partial
                  ? 'API (partially covered: closed-setup check only; full path needs --setup-from-bootstrap)'
                  : 'API';
        const steps = c.steps.length ? c.steps.join(', ') : '**none**';
        return `| ${c.row.id} | ${c.row.title.replace(/\|/g, '/')} | ${kind} | ${steps} |`;
      }),
      '',
    ].join('\n');
    await writeFile(join(outDir, 'summary.md'), this.redact(summary));
    await writeFile(
      join(outDir, 'results.json'),
      this.redact(
        JSON.stringify(
          {
            runId: this.runId,
            ...meta,
            passed,
            failed: failures,
            skipped,
            uncovered,
            steps: this.records,
          },
          null,
          2
        )
      ) + '\n'
    );
    return { uncovered, failures };
  }
}

function errorHint(reply: Reply): string {
  const body = reply.json as { error?: unknown; code?: unknown } | null;
  if (body && typeof body.error === 'string')
    return ` (${body.error}${typeof body.code === 'string' ? ', ' + body.code : ''})`;
  return '';
}

/** Read a nested value from a JSON reply, e.g. dig(r, 'data', 'id'). */
export function dig(reply: Reply, ...keys: Array<string | number>): unknown {
  let value: unknown = reply.json;
  for (const key of keys) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
