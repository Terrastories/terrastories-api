import type { RailsCaptureManifest } from './capture.js';

export function buildCaptureValidationSummary(
  manifest: RailsCaptureManifest
): string {
  const tableLines = Object.entries(manifest.tables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([tableName, table]) => `  - ${tableName}: ${table.rowCount} rows`);
  const selectionSummary =
    manifest.blobSelection.mode === 'all'
      ? 'all'
      : `community_allowlist (${manifest.blobSelection.communities
          .map((community) => community.id)
          .join(', ')})`;

  return [
    'Terrastories Rails Stage-1 Capture Validation Summary',
    '',
    manifest.complete
      ? 'Status: SOURCE PRESERVATION COMPLETE — NOT A V2 CUTOVER'
      : 'Status: PARTIAL CAPTURE (community_allowlist) — NOT A COMPLETE SOURCE CAPTURE',
    `Source profile: ${manifest.source.profile}`,
    `Contract profile: ${manifest.source.contractProfile}`,
    `Legacy commit: ${manifest.source.legacyCommit}`,
    `Pinned Rails schema version: ${manifest.source.pinnedRailsSchemaVersion}`,
    `Observed Rails schema version: ${manifest.source.observedSchemaVersion}`,
    `Source schema SHA-256: ${manifest.source.schemaSha256}`,
    `Blob source: ${manifest.storage.kind}`,
    `Blob selection: ${selectionSummary}`,
    `Archive: ${manifest.archive.filename}`,
    `Archive bytes: ${manifest.archive.byteSize}`,
    `Archive SHA-256: ${manifest.archive.sha256}`,
    `Tables: ${manifest.totals.tables}`,
    `Rows: ${manifest.totals.rows}`,
    `Blobs: ${manifest.totals.blobs}`,
    `Blobs selected: ${manifest.totals.blobsSelected}`,
    `Blobs not_selected: ${manifest.totals.blobsNotSelected}`,
    '',
    'Captured table counts:',
    ...tableLines,
    '',
    'This summary intentionally excludes source row contents, password hashes,',
    'provider credentials, database URLs, reset/session tokens, and media names.',
    ...(manifest.complete
      ? []
      : [
          'Partial bundle: for staging/rehearsal only. It never qualifies for cutover.',
        ]),
    'Validate custody/checksums and complete Stage 2 before any production cutover.',
    '',
  ].join('\n');
}
