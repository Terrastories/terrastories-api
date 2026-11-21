import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  decodeUtf8CsvStrict,
  hasCsvFormulaPrefix,
  MAX_CSV_ROWS,
  neutralizeCsvFormulaCell,
  parseCsvText,
} from '../../src/shared/utils/csv-parser.js';
import {
  D1_BUDGET_ALTERNATIVES_MESSAGE,
  D1_MAX_BATCH_STATEMENTS,
  D1_MAX_BOUND_PARAMS_PER_STATEMENT,
  D1_MAX_ESTIMATED_ROWS_WRITTEN,
  D1_MAX_STATEMENT_BYTES,
  planImportCommit,
  utcDayWindowMs,
} from '../../src/shared/utils/import-commit-plan.js';
import type {
  NormalizedPlaceRow,
  NormalizedStoryRow,
} from '../../src/shared/schemas/imports.js';

describe('CSV parser and formula-injection guards', () => {
  it('strips UTF-8 BOM and parses RFC 4180 CRLF, escaped quotes, and embedded newlines', () => {
    const raw = `\uFEFFname,description,region\r\n"River ""Bend""","Line 1\nLine 2",North\r\nValley,"Plain, comma",South\r\n`;
    const bytes = new TextEncoder().encode(raw);
    const decoded = decodeUtf8CsvStrict(bytes);
    expect(decoded.startsWith('name,')).toBe(true);

    const parsed = parseCsvText(decoded);
    expect(parsed.headers).toEqual(['name', 'description', 'region']);
    expect(parsed.rows).toEqual([
      {
        rowNumber: 1,
        csvLine: 2,
        cells: ['River "Bend"', 'Line 1\nLine 2', 'North'],
      },
      {
        rowNumber: 2,
        csvLine: 4,
        cells: ['Valley', 'Plain, comma', 'South'],
      },
    ]);
  });

  it('rejects invalid UTF-8, NUL bytes, unclosed quotes, stray quotes, duplicate/empty headers, and mismatched column counts without echoing content', () => {
    expect(() =>
      decodeUtf8CsvStrict(Uint8Array.from([0xff, 0xfe, 0x61]))
    ).toThrow(CsvParseError);
    expect(() =>
      decodeUtf8CsvStrict(Uint8Array.from([0x61, 0x00, 0x62]))
    ).toThrow(CsvParseError);

    expect(() => parseCsvText('')).toThrow(CsvParseError);
    expect(() => parseCsvText('name,region\n')).toThrow(CsvParseError);
    expect(() => parseCsvText('name,,region\na,b,c')).toThrow(CsvParseError);
    expect(() => parseCsvText('name,name\na,b')).toThrow(CsvParseError);
    expect(() => parseCsvText('name,region\n"unclosed,North')).toThrow(
      CsvParseError
    );
    expect(() => parseCsvText('name,region\n"abc"def,North')).toThrow(
      CsvParseError
    );
    expect(() => parseCsvText('name,region\nab"cd,North')).toThrow(
      CsvParseError
    );

    const secretMarker = 'SENSITIVE_CULTURAL_TEXT_DO_NOT_LEAK';
    let caught: unknown;
    try {
      parseCsvText(`name,region\n${secretMarker}`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CsvParseError);
    expect((caught as CsvParseError).code).toBe('column_count_mismatch');
    expect((caught as Error).message).not.toContain(secretMarker);
  });

  it('enforces maxRows, maxColumns, and maxCellLength bounds early while parsing', () => {
    expect(() => parseCsvText('a,b,c\n1,2,3', { maxColumns: 2 })).toThrow(
      CsvParseError
    );
    expect(() => parseCsvText('a\n1\n2\n3', { maxRows: 2 })).toThrow(
      CsvParseError
    );
    expect(() => parseCsvText('a\n12345', { maxCellLength: 4 })).toThrow(
      CsvParseError
    );

    // Aborts on row cap BEFORE hitting a trailing malformed unclosed quote.
    let tooManyRowsErr: unknown;
    try {
      parseCsvText('a\n1\n2\n3\n"unclosed', { maxRows: 2 });
    } catch (err) {
      tooManyRowsErr = err;
    }
    expect(tooManyRowsErr).toBeInstanceOf(CsvParseError);
    expect((tooManyRowsErr as CsvParseError).code).toBe('too_many_rows');

    // Aborts early on 500k short rows under default MAX_CSV_ROWS without buffering all records.
    let hugeRowsErr: unknown;
    try {
      parseCsvText(`a\n${'x\n'.repeat(500_000)}"unclosed`);
    } catch (err) {
      hugeRowsErr = err;
    }
    expect(hugeRowsErr).toBeInstanceOf(CsvParseError);
    expect((hugeRowsErr as CsvParseError).code).toBe('too_many_rows');
    expect(MAX_CSV_ROWS).toBe(5_000);

    // Aborts early on maxCellLength (unquoted and quoted with "" escapes / CRLF) before trailing unclosed quote.
    let unquotedCellErr: unknown;
    try {
      parseCsvText(`a\n${'x'.repeat(200_000)}\n"unclosed`, {
        maxCellLength: 100,
      });
    } catch (err) {
      unquotedCellErr = err;
    }
    expect(unquotedCellErr).toBeInstanceOf(CsvParseError);
    expect((unquotedCellErr as CsvParseError).code).toBe('cell_too_large');

    let quotedCellErr: unknown;
    try {
      parseCsvText(`a\n"ab""cd\r\n${'y'.repeat(100)}"\n"unclosed`, {
        maxCellLength: 50,
      });
    } catch (err) {
      quotedCellErr = err;
    }
    expect(quotedCellErr).toBeInstanceOf(CsvParseError);
    expect((quotedCellErr as CsvParseError).code).toBe('cell_too_large');

    // Blank line handling at boundaries.
    expect(parseCsvText('a\n1\n2\n\n\n', { maxRows: 2 }).rows).toHaveLength(2);
    expect(
      parseCsvText(`a\n1\n${'\n'.repeat(100_000)}`, { maxRows: 2 }).rows
    ).toHaveLength(1);
    expect(() => parseCsvText('a\n1\n\n2\n', { maxRows: 2 })).toThrow(
      CsvParseError
    );
    expect(parseCsvText('a\n1\n\n2\n', { maxRows: 3 }).rows).toEqual([
      { rowNumber: 1, csvLine: 2, cells: ['1'] },
      { rowNumber: 2, csvLine: 3, cells: [''] },
      { rowNumber: 3, csvLine: 4, cells: ['2'] },
    ]);

    let emptyErr: unknown;
    try {
      parseCsvText('\n\n\n');
    } catch (err) {
      emptyErr = err;
    }
    expect(emptyErr).toBeInstanceOf(CsvParseError);
    expect((emptyErr as CsvParseError).code).toBe('empty_csv');

    let emptyHeaderErr: unknown;
    try {
      parseCsvText('\na\n1\n');
    } catch (err) {
      emptyHeaderErr = err;
    }
    expect(emptyHeaderErr).toBeInstanceOf(CsvParseError);
    expect((emptyHeaderErr as CsvParseError).code).toBe('empty_header');
  });

  it('detects and neutralizes spreadsheet formula prefixes', () => {
    for (const bad of [
      '=cmd|"/c calc"!A0',
      '+1+1',
      '-2+3',
      '@SUM(1,2)',
      '\t=1+1',
      '\r+1',
      '\n=1+1',
      '\r\n=1+1',
      ' \n\t+1+1',
      '\n-2+3',
      '\n@SUM(1,2)',
      '\v=1+1',
      '\f=1+1',
      '\u00a0=1+1',
      '  =HYPERLINK("http://x")',
    ]) {
      expect(hasCsvFormulaPrefix(bad)).toBe(true);
      expect(neutralizeCsvFormulaCell(bad)).toBe(`'${bad}`);
    }

    for (const safe of [
      'River Bend',
      'A + B',
      '2026-06-01',
      '<p>Hello</p>',
      '\nRiver Bend',
      '\r\n<p>Safe</p>',
      'Line 1\nLine 2',
      '  Normal text',
    ]) {
      expect(hasCsvFormulaPrefix(safe)).toBe(false);
      expect(neutralizeCsvFormulaCell(safe)).toBe(safe);
    }
  });
});

describe('D1 commit-plan budget validator', () => {
  it('accepts a valid bounded plan within D1 limits', () => {
    const rows: NormalizedPlaceRow[] = [
      {
        rowNumber: 1,
        name: 'Cedar Ridge',
        normalizedName: 'cedar ridge',
        description: '<p>Lookout</p>',
        descriptionPlain: 'Lookout',
        typeOfPlace: 'ridge',
        region: 'North',
        latitude: -12.5,
        longitude: -60.25,
        attachments: [],
      },
    ];
    const plan = planImportCommit({
      normalizedData: {
        kind: 'places',
        rows,
        relatedPlacesToCreate: [],
        relatedSpeakersToCreate: [],
        skippedDuplicates: 0,
        audienceCounts: null,
      },
      stagedFileIds: [],
      manifestPayloadBytes: 512,
      sourceFilePayloadBytes: 420,
    });
    expect(plan.summary.withinD1Budget).toBe(true);
    expect(plan.violations).toEqual([]);
    expect(plan.summary.statementCount).toBeLessThanOrEqual(
      D1_MAX_BATCH_STATEMENTS
    );
    expect(plan.summary.maxBoundParams).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMS_PER_STATEMENT
    );
    expect(plan.summary.maxStatementBytes).toBeLessThanOrEqual(
      D1_MAX_STATEMENT_BYTES
    );
    expect(plan.summary.estimatedRowsWritten).toBeLessThanOrEqual(
      D1_MAX_ESTIMATED_ROWS_WRITTEN
    );
  });

  it('rejects > 1,000 statements with diagnostic naming the limit and alternatives', () => {
    const stories: NormalizedStoryRow[] = Array.from(
      { length: 1_005 },
      (_, idx) => ({
        rowNumber: idx + 1,
        title: `Story ${idx + 1}`,
        slug: `story-${idx + 1}`,
        description: null,
        descriptionPlain: null,
        visibility: 'community',
        topic: null,
        topicNormalized: null,
        language: 'en',
        dateInterviewed: null,
        interviewLocationRef: null,
        interviewerRef: null,
        placeRefs: [],
        speakerRefs: [],
        attachments: [],
        externalMediaLinks: [],
      })
    );
    const plan = planImportCommit({
      normalizedData: {
        kind: 'stories',
        rows: stories,
        relatedPlacesToCreate: [],
        relatedSpeakersToCreate: [],
        skippedDuplicates: 0,
        audienceCounts: { public: 0, community: stories.length, editors: 0 },
      },
      stagedFileIds: [],
      manifestPayloadBytes: 10_000,
      sourceFilePayloadBytes: 420,
    });
    expect(plan.summary.withinD1Budget).toBe(false);
    const stmtViolation = plan.violations.find(
      (v) => v.limit === 'max_statements'
    );
    expect(stmtViolation).toBeDefined();
    expect(stmtViolation?.message).toContain(String(D1_MAX_BATCH_STATEMENTS));
    expect(stmtViolation?.message).toContain(D1_BUDGET_ALTERNATIVES_MESSAGE);
  });

  it('rejects > 100 KB single statement (including multi-byte UTF-8) and > 50,000 rows written', () => {
    // Multi-byte UTF-8 string (~26k chars = ~104 KB UTF-8).
    const multiByteDesc = '𐍈'.repeat(26_500);
    const bigStory: NormalizedStoryRow = {
      rowNumber: 1,
      title: 'Big Unicode Story',
      slug: 'big-unicode',
      description: multiByteDesc,
      descriptionPlain: multiByteDesc,
      visibility: 'public',
      topic: null,
      topicNormalized: null,
      language: 'en',
      dateInterviewed: null,
      interviewLocationRef: null,
      interviewerRef: null,
      placeRefs: [],
      speakerRefs: [],
      attachments: [],
      externalMediaLinks: [],
    };

    const bigStmtPlan = planImportCommit({
      normalizedData: {
        kind: 'stories',
        rows: [bigStory],
        relatedPlacesToCreate: [],
        relatedSpeakersToCreate: [],
        skippedDuplicates: 0,
        audienceCounts: { public: 1, community: 0, editors: 0 },
      },
      stagedFileIds: [],
      manifestPayloadBytes: 50_000,
      sourceFilePayloadBytes: 420,
    });
    expect(bigStmtPlan.summary.withinD1Budget).toBe(false);
    const byteViolation = bigStmtPlan.violations.find(
      (v) => v.limit === 'max_statement_bytes'
    );
    expect(byteViolation).toBeDefined();
    expect(byteViolation?.message).toContain(String(D1_MAX_STATEMENT_BYTES));
    expect(byteViolation?.message).toContain(D1_BUDGET_ALTERNATIVES_MESSAGE);

    // 500 stories each with 50 edges (50 * 2 * 2 = 200 index/table rows written per story -> >50k rows).
    const heavyStories: NormalizedStoryRow[] = Array.from(
      { length: 300 },
      (_, idx) => ({
        rowNumber: idx + 1,
        title: `Heavy ${idx + 1}`,
        slug: `heavy-${idx + 1}`,
        description: null,
        descriptionPlain: null,
        visibility: 'editors',
        topic: null,
        topicNormalized: null,
        language: 'en',
        dateInterviewed: null,
        interviewLocationRef: null,
        interviewerRef: null,
        placeRefs: Array.from({ length: 45 }, (__, j) => ({
          kind: 'existing' as const,
          id: j + 1,
        })),
        speakerRefs: Array.from({ length: 45 }, (__, j) => ({
          kind: 'existing' as const,
          id: j + 1,
        })),
        attachments: [],
        externalMediaLinks: [],
      })
    );
    const heavyPlan = planImportCommit({
      normalizedData: {
        kind: 'stories',
        rows: heavyStories,
        relatedPlacesToCreate: [],
        relatedSpeakersToCreate: [],
        skippedDuplicates: 0,
        audienceCounts: {
          public: 0,
          community: 0,
          editors: heavyStories.length,
        },
      },
      stagedFileIds: [],
      manifestPayloadBytes: 10_000,
      sourceFilePayloadBytes: 420,
    });
    expect(heavyPlan.summary.withinD1Budget).toBe(false);
    const rowsViolation = heavyPlan.violations.find(
      (v) => v.limit === 'max_rows_written'
    );
    expect(rowsViolation).toBeDefined();
    expect(rowsViolation?.message).toContain(
      String(D1_MAX_ESTIMATED_ROWS_WRITTEN)
    );
    expect(rowsViolation?.message).toContain(D1_BUDGET_ALTERNATIVES_MESSAGE);
  });

  it('computes exact UTC day windows', () => {
    const d = new Date('2026-11-21T23:59:59.999Z');
    const win = utcDayWindowMs(d);
    expect(new Date(win.startMs).toISOString()).toBe(
      '2026-11-21T00:00:00.000Z'
    );
    expect(new Date(win.endMs).toISOString()).toBe('2026-11-22T00:00:00.000Z');
  });
});
