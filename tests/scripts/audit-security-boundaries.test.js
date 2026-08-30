import { describe, expect, it } from 'vitest';
import * as auditModule from '../../scripts/check-audit-baseline.mjs';

const basePolicy = {
  trackingIssue: 141,
  minimumSeverity: 'moderate',
  expires: '2026-09-30',
};

function advisory(nodes) {
  return {
    source: 'known',
    package: 'known-package',
    severity: 'moderate',
    url: 'https://example.invalid/known',
    nodes,
  };
}

describe('security audit trust boundaries', () => {
  it('binds accepted audit debt to normalized dependency installation paths', () => {
    const first = auditModule.computeAdvisorySetDigest([
      advisory(['node_modules/known-package']),
    ]);
    const reordered = auditModule.computeAdvisorySetDigest([
      advisory([
        'node_modules/a/node_modules/known-package',
        'node_modules/known-package',
      ]),
    ]);

    expect(reordered).not.toBe(first);
  });

  it('rejects broader dependency exposure for an already accepted advisory', () => {
    const baseline = {
      trackingIssue: 141,
      advisories: [advisory(['node_modules/known-package'])],
    };
    const policy = {
      ...basePolicy,
      review: {
        advisoriesSha256: auditModule.computeAdvisorySetDigest(
          baseline.advisories
        ),
      },
    };

    const comparison = auditModule.compareAuditAdvisories(baseline, policy, {
      vulnerabilities: {
        'known-package': {
          nodes: [
            'node_modules/known-package',
            'node_modules/a/node_modules/known-package',
          ],
          via: [
            {
              source: 'known',
              severity: 'moderate',
              url: 'https://example.invalid/known',
            },
          ],
        },
      },
    });

    expect(comparison.pathChanges).toEqual([
      expect.objectContaining({
        source: 'known',
        package: 'known-package',
        previousNodes: ['node_modules/known-package'],
        nodes: [
          'node_modules/a/node_modules/known-package',
          'node_modules/known-package',
        ],
      }),
    ]);
  });

  it('requires an exact external approval from a repository writer', () => {
    expect(typeof auditModule.validateExternalAuditApproval).toBe('function');
    if (typeof auditModule.validateExternalAuditApproval !== 'function') return;

    const policySha256 = 'a'.repeat(64);
    const policy = {
      ...basePolicy,
      review: { policySha256 },
    };
    const approvalBody = `SECURITY-AUDIT-APPROVAL v1 policySha256=${policySha256} trackingIssue=141`;

    expect(() =>
      auditModule.validateExternalAuditApproval(policy, [
        {
          body: approvalBody,
          author: 'trusted-maintainer',
          permission: 'write',
        },
      ])
    ).not.toThrow();

    expect(() =>
      auditModule.validateExternalAuditApproval(policy, [
        {
          body: approvalBody,
          author: 'read-only-user',
          permission: 'read',
        },
      ])
    ).toThrow(/trusted|write|admin|approval/i);

    expect(() =>
      auditModule.validateExternalAuditApproval(policy, [
        {
          body: approvalBody.replace(policySha256, 'b'.repeat(64)),
          author: 'trusted-maintainer',
          permission: 'admin',
        },
      ])
    ).toThrow(/exact|digest|approval/i);
  });
});
