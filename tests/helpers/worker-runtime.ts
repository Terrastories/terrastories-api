/**
 * Shared workerd runtime for the Hono worker tests and the Workers persona
 * QA fixture (#199).
 *
 * Both need the same three steps: bundle `src/worker.ts` (behind a
 * caller-supplied gateway module) into a browser-platform ESM string with no
 * runtime imports, execute it in workerd through Miniflare with the D1 `DB`
 * and R2 `MEDIA` bindings of the Workers Free profile, and apply the
 * repository's SQLite migrations to D1 through the binding.
 */
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

/** Same compatibility date tests/hono/worker.test.ts pinned first. */
const compatibilityDate = '2026-04-26';

/** The D1 binding type Miniflare actually hands back, whatever the pin. */
export type MiniflareD1Database = Awaited<
  ReturnType<Miniflare['getD1Database']>
>;

/**
 * Bundle a worker gateway (which imports from `./src/worker.js`) to a single
 * ESM script for workerd. Fails when any output still imports anything at
 * runtime: the script must execute with no Node modules and no network.
 */
export async function bundleWorkerModule(contents: string): Promise<string> {
  const bundle = await build({
    stdin: {
      contents,
      resolveDir: process.cwd(),
      sourcefile: 'worker-fixture.ts',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    metafile: true,
    external: ['path', 'os', 'crypto'],
  });
  for (const output of Object.values(bundle.metafile!.outputs))
    if (output.imports.length > 0)
      throw new Error(
        `worker bundle must import nothing at runtime: ${output.imports
          .map((dependency) => dependency.path)
          .join(', ')}`
      );
  return bundle.outputFiles![0].text;
}

/** Run a bundled worker in workerd with the Workers Free bindings. */
export function startWorkerRuntime(script: string): Miniflare {
  return new Miniflare({
    modules: true,
    script,
    compatibilityDate,
    d1Databases: ['DB'],
    r2Buckets: ['MEDIA'],
  });
}

/**
 * Apply the repository's SQLite migrations to a D1 binding: the journal's
 * statements in order, split on Drizzle's breakpoint marker, batched in
 * chunks of 50 exactly like the D1 `batch` limit allows.
 */
export async function applyD1Migrations(
  db: MiniflareD1Database,
  directory = 'src/db/migrations'
): Promise<void> {
  const journal = JSON.parse(
    await readFile(`${directory}/meta/_journal.json`, 'utf8')
  );
  const statements: string[] = [];
  for (const entry of journal.entries) {
    const source = await readFile(`${directory}/${entry.tag}.sql`, 'utf8');
    statements.push(
      ...source
        .split('--> statement-breakpoint')
        .map((sql) => sql.trim())
        .filter(Boolean)
    );
  }
  for (let offset = 0; offset < statements.length; offset += 50)
    await db.batch(
      statements.slice(offset, offset + 50).map((sql) => db.prepare(sql))
    );
}
