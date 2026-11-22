import { describe, expect, it } from 'vitest';
import { REQUIRED_RAILS_TABLES_2025 } from '../../src/migration/rails/contract.js';
import {
  COLUMN_DISPOSITIONS,
  FIELD_DISPOSITIONS,
  findUnregisteredColumns,
  parseDisposition,
} from '../../src/migration/v2/dispositions.js';
import { parseArgs } from '../../scripts/migrate-rails-transform.js';

describe('Stage-2 disposition registry', () => {
  it('has an entry for every pinned Rails column', () => {
    const discovered = Object.fromEntries(
      Object.entries(REQUIRED_RAILS_TABLES_2025).map(([t, c]) => [t, [...c]])
    );
    expect(findUnregisteredColumns(discovered)).toEqual([]);
  });

  it('flags a new column and only uses known dispositions', () => {
    expect(findUnregisteredColumns({ users: ['id', 'brand_new'] })).toEqual([
      'users.brand_new',
    ]);
    for (const table of Object.values(COLUMN_DISPOSITIONS)) {
      for (const value of Object.values(table)) {
        for (const d of parseDisposition(value).dispositions) {
          expect(FIELD_DISPOSITIONS).toContain(d);
        }
      }
    }
  });
});

describe('transform CLI args', () => {
  it('parses repeatable communities and flags', () => {
    expect(
      parseArgs([
        '--bundle',
        'b',
        '--output',
        'o',
        '--community',
        'a',
        '--community',
        '2',
        '--include-system-users',
        '--allow-manual',
      ])
    ).toEqual({
      help: false,
      bundleDir: 'b',
      outputDir: 'o',
      communities: ['a', '2'],
      includeSystemUsers: true,
      allowManual: true,
    });
  });
  it('requires bundle and output, rejects unknown args', () => {
    expect(() => parseArgs(['--bundle', 'b'])).toThrow(/--output/);
    expect(() =>
      parseArgs(['--bundle', 'b', '--output', 'o', '--x', 'y'])
    ).toThrow(/Unknown/);
  });
});
