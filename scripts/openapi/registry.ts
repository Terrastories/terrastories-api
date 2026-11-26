import { readFileSync } from 'node:fs';

/**
 * Machine-readable view of docs/V2-ROUTE-REGISTRY.md (#148). The markdown
 * tables stay the single source of truth; this module only parses them so the
 * drift test and the OpenAPI generator never keep a second copy.
 */
export interface RegistryRow {
  method: string;
  path: string;
  purpose: string;
  who: string;
  status: string;
}

export const REGISTRY_PATH = 'docs/V2-ROUTE-REGISTRY.md';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** Split a markdown table row on pipes that are not escaped as \\|. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  // A row starts and ends with a pipe: drop the empty edge cells.
  return cells.slice(1, -1).map((cell) => cell.trim());
}

const unwrap = (cell: string): string => cell.replace(/^`+|`+$/g, '').trim();

/** Every operation row of the registry, in document order. */
export function parseRegistry(markdown: string): RegistryRow[] {
  const rows: RegistryRow[] = [];
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line);
    const method = unwrap(cells[0] ?? '');
    if (!METHODS.has(method)) continue;
    const path = unwrap(cells[1] ?? '');
    if (!path.startsWith('/')) continue;
    rows.push({
      method,
      path,
      purpose: cells[2] ?? '',
      who: cells[3] ?? '',
      status: cells[cells.length - 1] ?? '',
    });
  }
  return rows;
}

export function readRegistry(): RegistryRow[] {
  return parseRegistry(readFileSync(REGISTRY_PATH, 'utf8'));
}

/**
 * Rows that describe a route the app must mount today. Deferred items and
 * optional adapters are documented but intentionally not registered.
 */
export function isMountedStatus(status: string): boolean {
  return !/^`?(deferred|optional adapter)/i.test(status.trim());
}

export const routeKey = (method: string, path: string): string =>
  `${method} ${path}`;
