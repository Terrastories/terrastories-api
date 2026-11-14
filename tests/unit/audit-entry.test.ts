import { describe, expect, it } from 'vitest';
import {
  AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS,
  AuditEntryValidationError,
  auditNetworkMetadataCutoff,
  scrubAuditNetworkMetadataRecord,
  validateContentFreeAuditEntry,
} from '../../src/shared/utils/audit-entry.js';

describe('AuditEntry content-free validator and 90-day scrub helper', () => {
  it('accepts content-free auth and community resource entries', () => {
    expect(
      validateContentFreeAuditEntry({
        communityId: null,
        actorId: 42,
        action: 'auth.login',
        resourceType: 'session',
        resourceIds: [9, 'sess_abc123'],
        outcome: 'success',
        ipAddress: '203.0.113.10',
        userAgent: 'Mozilla/5.0',
      })
    ).toEqual({
      communityId: null,
      actorId: 42,
      action: 'auth.login',
      resourceType: 'session',
      resourceIds: [9, 'sess_abc123'],
      outcome: 'success',
      ipAddress: '203.0.113.10',
      userAgent: 'Mozilla/5.0',
    });

    expect(
      validateContentFreeAuditEntry({
        communityId: 7,
        actorId: 11,
        action: 'story.publish',
        resourceType: 'story',
        resourceIds: [101],
        outcome: 'success',
      })
    ).toEqual({
      communityId: 7,
      actorId: 11,
      action: 'story.publish',
      resourceType: 'story',
      resourceIds: [101],
      outcome: 'success',
      ipAddress: null,
      userAgent: null,
    });
  });

  it('rejects forbidden content fields, free-text payloads, and IP/UA on content resources', () => {
    const base = {
      communityId: 1,
      actorId: 2,
      action: 'story.update',
      resourceType: 'story',
      resourceIds: [12],
      outcome: 'success',
    };
    for (const extra of [
      { description: 'Sacred river' },
      { title: 'River Story' },
      { name: 'Speaker Name' },
      { email: 'a@b.org' },
      { username: 'handle' },
      { details: { note: 'x' } },
      { metadata: { extra: true } },
      { token: 'secret' },
      { url: 'https://example.com' },
    ]) {
      expect(() =>
        validateContentFreeAuditEntry({ ...base, ...extra })
      ).toThrow(AuditEntryValidationError);
    }
    expect(() =>
      validateContentFreeAuditEntry({
        action: 'Updated story: Title',
        outcome: 'success',
      })
    ).toThrow(AuditEntryValidationError);
    expect(() =>
      validateContentFreeAuditEntry({
        action: 'story.create',
        resourceType: 'story',
        resourceIds: ['My Story Title'],
        outcome: 'success',
      })
    ).toThrow(AuditEntryValidationError);
    expect(() =>
      validateContentFreeAuditEntry({ ...base, ipAddress: '198.51.100.2' })
    ).toThrow(AuditEntryValidationError);
  });

  it('scrubs ipAddress and userAgent at or before the 90-day cutoff idempotently', () => {
    const now = new Date('2026-11-14T12:00:00.000Z');
    const cutoff = auditNetworkMetadataCutoff(
      now,
      AUDIT_NETWORK_METADATA_MAX_RETENTION_DAYS
    );
    expect(() => auditNetworkMetadataCutoff(now, 91)).toThrow(
      AuditEntryValidationError
    );
    expect(() => auditNetworkMetadataCutoff(now, 0)).toThrow(
      AuditEntryValidationError
    );

    const base = {
      id: 1,
      communityId: null,
      actorId: 10,
      action: 'auth.login',
      resourceType: 'session',
      resourceIds: [1],
      outcome: 'success',
      ipAddress: '203.0.113.5',
      userAgent: 'TestAgent/1.0',
    };

    const expired = scrubAuditNetworkMetadataRecord(
      { ...base, createdAt: new Date(cutoff.getTime() - 1000) },
      cutoff
    );
    expect(expired.scrubbed).toBe(true);
    expect(expired.entry.ipAddress).toBeNull();
    expect(expired.entry.userAgent).toBeNull();
    expect(expired.entry.action).toBe('auth.login');
    expect(
      scrubAuditNetworkMetadataRecord(expired.entry, cutoff).scrubbed
    ).toBe(false);

    const recent = scrubAuditNetworkMetadataRecord(
      { ...base, createdAt: new Date(cutoff.getTime() + 1000) },
      cutoff
    );
    expect(recent.scrubbed).toBe(false);
    expect(recent.entry.ipAddress).toBe('203.0.113.5');
    expect(recent.entry.userAgent).toBe('TestAgent/1.0');
  });
});
