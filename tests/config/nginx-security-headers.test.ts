/**
 * nginx and the Hono API must not both set security headers on a proxied V2
 * response (#138). nginx inherits add_header from http/server into every
 * location that defines none, so the shipped configs may only add headers on
 * locations nginx answers itself. nginx is not available in CI, so this
 * checks the config structure instead of a live response.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

interface Block {
  name: string;
  addHeaders: string[];
  errorPages: string[];
  children: Block[];
}

function parse(source: string): Block {
  const root: Block = {
    name: 'root',
    addHeaders: [],
    errorPages: [],
    children: [],
  };
  const stack = [root];
  const text = source.replace(/#.*$/gm, '').replace(/'[^']*'|"[^"]*"/g, '""');
  for (const stmt of text.split(/([{};])/)) {
    const top = stack[stack.length - 1]!;
    const trimmed = stmt.trim();
    if (trimmed === '{' || trimmed === '' || trimmed === ';') continue;
    if (trimmed === '}') {
      stack.pop();
      continue;
    }
    // A statement followed by '{' opens a block; otherwise a directive.
    const idx = text.indexOf(stmt) + stmt.length;
    const next = text.slice(idx).trimStart()[0];
    if (next === '{') {
      const child: Block = {
        name: trimmed,
        addHeaders: [],
        errorPages: [],
        children: [],
      };
      top.children.push(child);
      stack.push(child);
    } else if (trimmed.startsWith('error_page ')) {
      top.errorPages.push(trimmed.split(/\s+/).pop()!);
    } else if (trimmed.startsWith('add_header ')) {
      top.addHeaders.push(trimmed.split(/\s+/)[1]!.toLowerCase());
    }
  }
  return root;
}

function walk(
  block: Block,
  fn: (b: Block, parents: Block[]) => void,
  parents: Block[] = []
) {
  fn(block, parents);
  for (const child of block.children) walk(child, fn, [...parents, block]);
}

describe.each(['nginx.conf', 'nginx.field-kit.conf'])('%s', (file) => {
  const root = parse(readFileSync(`config/nginx/${file}`, 'utf8'));
  it('parses http, server and location blocks', () => {
    let locations = 0;
    walk(root, (b) => {
      if (b.name.startsWith('location ')) locations++;
    });
    expect(locations).toBeGreaterThan(3);
  });
  it('adds no http- or server-level headers inherited by proxied /v2/', () => {
    walk(root, (b) => {
      if (b.name === 'http' || b.name.startsWith('server'))
        expect(b.addHeaders, `add_header at ${b.name}`).toEqual([]);
    });
  });
  it('adds no headers on proxied /v2 locations', () => {
    let seen = 0;
    walk(root, (b) => {
      if (/^location \/v2/.test(b.name)) {
        seen++;
        expect(b.addHeaders, b.name).toEqual([]);
      }
    });
    expect(seen).toBeGreaterThanOrEqual(2);
  });
  it('answers nginx-generated /v2 failures with the baseline headers', () => {
    const named = new Map<string, Block>();
    walk(root, (b) => {
      if (b.name.startsWith('location @')) named.set(b.name.slice(10), b);
    });
    walk(root, (b) => {
      if (!/^location \/v2/.test(b.name)) return;
      const target = b.errorPages.find((p) => p.startsWith('@'));
      expect(target, `error_page in ${b.name}`).toBeDefined();
      const handler = named.get(target!.slice(1));
      expect(handler, target).toBeDefined();
      for (const h of [
        'x-content-type-options',
        'x-frame-options',
        'content-security-policy',
        'cache-control',
      ])
        expect(handler!.addHeaders, `${target} ${h}`).toContain(h);
    });
  });

  it('proxies /health with the forwarded scheme so the API owns HSTS', () => {
    const source = readFileSync(`config/nginx/${file}`, 'utf8');
    const health = source.match(/location \/health \{[^}]*\}/)![0];
    expect(health).toContain('proxy_set_header X-Forwarded-Proto $scheme');
  });

  it('uses the API HSTS policy (no includeSubDomains) wherever nginx sets it', () => {
    const source = readFileSync(`config/nginx/${file}`, 'utf8');
    for (const m of source.matchAll(/Strict-Transport-Security\s+"([^"]+)"/g))
      expect(m[1]).toBe('max-age=31536000');
  });
});
