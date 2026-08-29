import { readFile, writeFile } from 'node:fs/promises';

const capturePath = 'src/migration/rails/capture.ts';
let capture = await readFile(capturePath, 'utf8');

const importAnchor = `import {
  type CapturedBlob,
  verifyAndCopyActiveStorageBlob,
} from './active-storage.js';
`;
const importReplacement = `${importAnchor}import { buildCaptureValidationSummary } from './validation-summary.js';
`;
if (capture.split(importAnchor).length !== 2) {
  throw new Error('capture import anchor changed');
}
capture = capture.replace(importAnchor, importReplacement);

const manifestAnchor = `    await writeFile(
      join(temporaryDir, 'manifest.json'),
      \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`,
      { encoding: 'utf8', mode: 0o600 }
    );

    await client.query('COMMIT');
`;
const manifestReplacement = `    await writeFile(
      join(temporaryDir, 'manifest.json'),
      \`${'${JSON.stringify(manifest, null, 2)}'}\\n\`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await writeFile(
      join(temporaryDir, 'validation-summary.txt'),
      buildCaptureValidationSummary(manifest),
      { encoding: 'utf8', mode: 0o600 }
    );

    await client.query('COMMIT');
`;
if (capture.split(manifestAnchor).length !== 2) {
  throw new Error('manifest write anchor changed');
}
capture = capture.replace(manifestAnchor, manifestReplacement);
await writeFile(capturePath, capture);

const activePath = 'src/migration/rails/active-storage.ts';
let active = await readFile(activePath, 'utf8');
const oldDiagnostic =
  'ActiveStorage blob path escapes trusted export root for key ${key}';
const newDiagnostic =
  'ActiveStorage blob path is outside trusted export root for key ${key}';
if (active.split(oldDiagnostic).length !== 2) {
  throw new Error('path escape diagnostic anchor changed');
}
active = active.replace(oldDiagnostic, newDiagnostic);
await writeFile(activePath, active);
