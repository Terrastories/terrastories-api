import { describe, it, expect } from 'vitest';
import {
  attachmentsPg,
  attachmentsSqlite,
  getAttachmentsTable,
  insertAttachmentSchema,
  type Attachment,
  type NewAttachment,
} from '../../src/db/schema/attachments.js';

describe('Attachments Schema', () => {
  describe('Multi-Database Support', () => {
    it('should export PostgreSQL table definition', () => {
      expect(attachmentsPg).toBeDefined();
    });

    it('should export SQLite table definition', () => {
      expect(attachmentsSqlite).toBeDefined();
    });

    it('should have getAttachmentsTable function for runtime selection', async () => {
      const table = await getAttachmentsTable();
      expect(table).toBeDefined();
    });
  });

  describe('Schema Structure', () => {
    it('should have all required fields', async () => {
      const table = await getAttachmentsTable();
      const columns = Object.keys(table);
      expect(columns).toContain('id');
      expect(columns).toContain('attachableId');
      expect(columns).toContain('attachableType');
      expect(columns).toContain('url');
      expect(columns).toContain('filename');
      expect(columns).toContain('contentType');
      expect(columns).toContain('fileSize');
      expect(columns).toContain('createdAt');
    });
  });

  describe('Zod Validation Schemas', () => {
    it('should validate a complete attachment object', () => {
      const validAttachment = {
        attachableId: 1,
        attachableType: 'Story',
        url: 'https://example.com/image.jpg',
        filename: 'image.jpg',
        contentType: 'image/jpeg',
        fileSize: 12345,
      };
      expect(() => insertAttachmentSchema.parse(validAttachment)).not.toThrow();
    });

    it('should reject invalid URL', () => {
      const invalidAttachment = {
        attachableId: 1,
        attachableType: 'Story',
        url: 'not-a-url',
        filename: 'image.jpg',
      };
      expect(() => insertAttachmentSchema.parse(invalidAttachment)).toThrow();
    });

    it('should require attachableId and attachableType', () => {
      const invalidAttachment = {
        url: 'https://example.com/image.jpg',
        filename: 'image.jpg',
      };
      expect(() => insertAttachmentSchema.parse(invalidAttachment)).toThrow();
    });
  });

  describe('TypeScript Types', () => {
    it('should export Attachment type', () => {
      const attachment: Attachment = {
        id: 1,
        attachableId: 1,
        attachableType: 'Story',
        url: 'https://example.com/image.jpg',
        filename: 'image.jpg',
        contentType: 'image/jpeg',
        fileSize: 12345,
        createdAt: new Date(),
      };
      expect(attachment).toBeDefined();
    });

    it('should export NewAttachment type', () => {
      const newAttachment: NewAttachment = {
        attachableId: 1,
        attachableType: 'Story',
        url: 'https://example.com/image.jpg',
        filename: 'image.jpg',
      };
      expect(newAttachment).toBeDefined();
    });
  });
});