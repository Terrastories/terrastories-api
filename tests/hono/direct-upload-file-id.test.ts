import { describe, expect, it } from 'vitest';
import { deriveDirectUploadFileId } from '../../src/services/direct-upload.service.js';

// Import media references accept only RFC 4122 v1-5 UUIDs
// (src/services/imports.service.ts), so direct-upload File ids must match.
const V1_TO_5 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('deriveDirectUploadFileId', () => {
  it('is deterministic and distinct per upload', async () => {
    const a = await deriveDirectUploadFileId(
      '11111111-1111-4111-8111-111111111111'
    );
    const b = await deriveDirectUploadFileId(
      '22222222-2222-4222-8222-222222222222'
    );
    expect(
      await deriveDirectUploadFileId('11111111-1111-4111-8111-111111111111')
    ).toBe(a);
    expect(a).not.toBe(b);
  });

  it('produces ids the CSV import UUID check accepts', async () => {
    for (let i = 0; i < 50; i += 1) {
      const id = await deriveDirectUploadFileId(`upload-${i}`);
      expect(id).toMatch(V1_TO_5);
    }
  });
});
