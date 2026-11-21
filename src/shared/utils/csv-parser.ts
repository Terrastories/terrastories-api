/**
 * Strict RFC 4180 CSV parser and formula-injection guards (SPEC-V2 §4, §6.9;
 * Issue #123). Pure TypeScript with zero Node-only imports so it runs identically
 * on Cloudflare Workers and Node.js.
 *
 * Content-free guarantee: error messages never echo CSV cell values or header
 * text.
 */

export const MAX_CSV_ROWS = 5_000;
export const MAX_CSV_COLUMNS = 64;
export const MAX_CSV_CELL_LENGTH = 80_000;

export type CsvParseErrorCode =
  | 'invalid_utf8'
  | 'nul_byte'
  | 'empty_csv'
  | 'malformed_csv'
  | 'duplicate_header'
  | 'empty_header'
  | 'column_count_mismatch'
  | 'too_many_columns'
  | 'too_many_rows'
  | 'cell_too_large';

export class CsvParseError extends Error {
  constructor(
    public readonly code: CsvParseErrorCode,
    message: string,
    public readonly rowNumber?: number,
    public readonly csvLine?: number
  ) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export interface ParsedCsvRow {
  /** 1-based data row index (first data row after headers is 1). */
  rowNumber: number;
  /** 1-based physical CSV line where this record begins. */
  csvLine: number;
  cells: string[];
}

export interface ParsedCsvResult {
  headers: string[];
  rows: ParsedCsvRow[];
}

/**
 * Decode CSV bytes as strict UTF-8, rejecting NUL bytes and invalid UTF-8
 * sequences and stripping a single leading UTF-8 BOM if present.
 */
export function decodeUtf8CsvStrict(bytes: Uint8Array): string {
  for (let i = 0; i < bytes.byteLength; i++) {
    if (bytes[i] === 0x00) {
      throw new CsvParseError(
        'nul_byte',
        'CSV file contains disallowed NUL bytes'
      );
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvParseError('invalid_utf8', 'CSV file must be valid UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  return text;
}

/**
 * Parse RFC 4180 CSV text strictly.
 *
 * - Supports `\r\n`, `\n`, `\r` line endings outside quotes.
 * - Supports `""` escaped quotes and embedded newlines inside quoted fields.
 * - Fails closed on unclosed quotes, stray quotes in unquoted fields,
 *   trailing characters after a closing quote, empty or duplicate headers,
 *   inconsistent column counts, or exceeded bounds.
 */
export function parseCsvText(
  text: string,
  options: {
    maxRows?: number;
    maxColumns?: number;
    maxCellLength?: number;
  } = {}
): ParsedCsvResult {
  if (text.includes('\0')) {
    throw new CsvParseError(
      'nul_byte',
      'CSV file contains disallowed NUL bytes'
    );
  }
  const maxRows = options.maxRows ?? MAX_CSV_ROWS;
  const maxColumns = options.maxColumns ?? MAX_CSV_COLUMNS;
  const maxCellLength = options.maxCellLength ?? MAX_CSV_CELL_LENGTH;

  if (text.length === 0) {
    throw new CsvParseError('empty_csv', 'CSV file is empty');
  }

  let headers: string[] | null = null;
  const rows: ParsedCsvRow[] = [];
  let leadingBlankLine: number | null = null;
  const pendingBlankLines: number[] = [];
  let overflowBlankCount = 0;

  let rowCells: string[] = [];
  let cellParts: string[] = [];
  let segmentStart = -1;
  let cellLength = 0;
  let inQuotes = false;
  let justClosedQuote = false;
  let atCellStart = true;
  let currentLine = 1;
  let recordStartLine = 1;

  const consumeChars = (count: number) => {
    cellLength += count;
    if (cellLength > maxCellLength) {
      throw new CsvParseError(
        'cell_too_large',
        `CSV cell exceeds maximum length of ${maxCellLength} characters`,
        undefined,
        recordStartLine
      );
    }
  };

  const flushSegment = (endIdx: number) => {
    if (segmentStart >= 0 && endIdx > segmentStart) {
      cellParts.push(text.slice(segmentStart, endIdx));
    }
    segmentStart = -1;
  };

  const pushCell = (endIdx: number) => {
    if (rowCells.length >= maxColumns) {
      throw new CsvParseError(
        'too_many_columns',
        `CSV exceeds maximum of ${maxColumns} columns`,
        undefined,
        recordStartLine
      );
    }
    flushSegment(endIdx);
    const value =
      cellParts.length === 0
        ? ''
        : cellParts.length === 1
          ? cellParts[0]!
          : cellParts.join('');
    rowCells.push(value);
    cellParts = [];
    cellLength = 0;
    atCellStart = true;
    justClosedQuote = false;
    segmentStart = -1;
  };

  const validateHeaders = (
    rawHeaders: string[],
    headerLine: number
  ): string[] => {
    const validated: string[] = [];
    const seenHeaders = new Set<string>();
    for (const raw of rawHeaders) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        throw new CsvParseError(
          'empty_header',
          'CSV header column names must not be empty',
          undefined,
          headerLine
        );
      }
      if (seenHeaders.has(trimmed)) {
        throw new CsvParseError(
          'duplicate_header',
          'CSV contains duplicate column headers',
          undefined,
          headerLine
        );
      }
      seenHeaders.add(trimmed);
      validated.push(trimmed);
    }
    return validated;
  };

  const pushDataRow = (cells: string[], csvLine: number) => {
    if (rows.length >= maxRows) {
      throw new CsvParseError(
        'too_many_rows',
        `CSV exceeds maximum of ${maxRows} data rows`,
        rows.length + 1,
        csvLine
      );
    }
    const rowNumber = rows.length + 1;
    if (cells.length !== headers!.length) {
      throw new CsvParseError(
        'column_count_mismatch',
        `CSV row ${rowNumber} column count does not match header count`,
        rowNumber,
        csvLine
      );
    }
    rows.push({
      rowNumber,
      csvLine,
      cells,
    });
  };

  const pushRecord = (endIdx: number) => {
    pushCell(endIdx);
    const cells = rowCells;
    rowCells = [];
    const isBlankLine = cells.length === 1 && cells[0] === '';

    if (headers === null) {
      if (isBlankLine) {
        if (leadingBlankLine === null) {
          leadingBlankLine = recordStartLine;
        }
        return;
      }
      if (leadingBlankLine !== null) {
        throw new CsvParseError(
          'empty_header',
          'CSV header column names must not be empty',
          undefined,
          leadingBlankLine
        );
      }
      headers = validateHeaders(cells, recordStartLine);
      return;
    }

    if (isBlankLine) {
      if (rows.length + pendingBlankLines.length < maxRows) {
        pendingBlankLines.push(recordStartLine);
      } else {
        overflowBlankCount += 1;
      }
      return;
    }

    if (
      overflowBlankCount > 0 ||
      rows.length + pendingBlankLines.length + 1 > maxRows
    ) {
      throw new CsvParseError(
        'too_many_rows',
        `CSV exceeds maximum of ${maxRows} data rows`,
        undefined,
        recordStartLine
      );
    }

    for (const blankLine of pendingBlankLines) {
      pushDataRow([''], blankLine);
    }
    pendingBlankLines.length = 0;
    pushDataRow(cells, recordStartLine);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          flushSegment(i);
          consumeChars(1);
          cellParts.push('"');
          i += 1;
          segmentStart = i + 1;
        } else {
          flushSegment(i);
          inQuotes = false;
          justClosedQuote = true;
        }
      } else if (ch === '\r') {
        if (i + 1 < text.length && text[i + 1] === '\n') {
          consumeChars(2);
          i += 1;
        } else {
          consumeChars(1);
        }
        currentLine += 1;
      } else if (ch === '\n') {
        consumeChars(1);
        currentLine += 1;
      } else {
        consumeChars(1);
      }
      continue;
    }

    if (justClosedQuote) {
      if (ch === ',') {
        pushCell(i);
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const end = i;
        if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
          i += 1;
        }
        pushRecord(end);
        currentLine += 1;
        recordStartLine = currentLine;
        continue;
      }
      throw new CsvParseError(
        'malformed_csv',
        'Unexpected character after closing quote in CSV',
        undefined,
        recordStartLine
      );
    }

    if (atCellStart && ch === '"') {
      inQuotes = true;
      atCellStart = false;
      segmentStart = i + 1;
      continue;
    }

    if (ch === '"') {
      throw new CsvParseError(
        'malformed_csv',
        'Unexpected quote inside unquoted CSV field',
        undefined,
        recordStartLine
      );
    }

    if (ch === ',') {
      pushCell(i);
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      const end = i;
      if (ch === '\r' && i + 1 < text.length && text[i + 1] === '\n') {
        i += 1;
      }
      pushRecord(end);
      currentLine += 1;
      recordStartLine = currentLine;
      continue;
    }

    if (atCellStart) {
      segmentStart = i;
      atCellStart = false;
    }
    consumeChars(1);
  }

  if (inQuotes) {
    throw new CsvParseError(
      'malformed_csv',
      'Unclosed quoted field in CSV',
      undefined,
      recordStartLine
    );
  }

  if (!atCellStart || rowCells.length > 0 || justClosedQuote) {
    pushRecord(text.length);
  }

  if (headers === null) {
    throw new CsvParseError('empty_csv', 'CSV file has no header row');
  }

  if (rows.length === 0) {
    throw new CsvParseError('empty_csv', 'CSV file contains no data rows');
  }

  return { headers, rows };
}

/**
 * Detect dangerous spreadsheet formula prefixes (`=`, `+`, `-`, `@`, or
 * leading tab/CR/whitespace followed by one of those operators).
 * Callers must apply this to text fields only, never numeric coordinates.
 */
export function hasCsvFormulaPrefix(value: string): boolean {
  return /^(?:[=@+\-]|[\t\r\u000b\u000c ]+[=@+\-])/.test(value);
}

/**
 * Neutralize a CSV cell value for export by prefixing a leading apostrophe
 * when it starts with a formula operator or whitespace + formula operator.
 */
export function neutralizeCsvFormulaCell(value: string): string {
  return hasCsvFormulaPrefix(value) ? `'${value}` : value;
}
