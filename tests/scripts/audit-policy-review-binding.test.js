import { describe, expect, it } from 'vitest';
import * as auditModule from '../../scripts/check-audit-baseline.mjs';

describe('security audit review policy binding', () => {
  const baseline = {
    trackingIssue: 141,
    advisories: [
      {
        source: 'known',
        package: 'known-package',
        severity: 'moderate',
        url: 'https://example.invalid/known',
      },
    ],
  };

  const policy = {
    trackingIssue: 141,
    minimumSeverity: 'moderate',
    expires: '2026-09-30',
  };

  const report = {
    vulnerabilities: {
      'known-package': {
        via: [
          {
            source: 'known',
            severity: 'moderate',
            url: 'https://example.invalid/known',
          },
        ],
      },
    },
  };

  it('binds accepted review to expiry, severity threshold, tracking issue, and advisory set', () => {
    expect(typeof auditModule.computeReviewedPolicyDigest).toBe('function');

    const digest = auditModule.computeReviewedPolicyDigest(
      baseline.advisories,
      policy
    );

    expect(
      auditModule.computeReviewedPolicyDigest(baseline.advisories, {
        ...policy,
        expires: '2026-10-31',
      })
    ).not.toBe(digest);
    expect(
      auditModule.computeReviewedPolicyDigest(baseline.advisories, {
        ...policy,
        minimumSeverity: 'high',
      })
    ).not.toBe(digest);
    expect(
      auditModule.computeReviewedPolicyDigest(baseline.advisories, {
        ...policy,
        trackingIssue: 142,
      })
    ).not.toBe(digest);
  });

  it('rejects extending the expiry without a fresh reviewed-policy digest', () => {
    const reviewedPolicySha256 = auditModule.computeReviewedPolicyDigest(
      baseline.advisories,
      policy
    );
    const acceptedPolicy = {
      ...policy,
      review: {
        status: 'accepted',
        reviewedBy: 'Terrastories maintainers',
        reviewedOn: '2026-08-28',
        rationale: 'Reviewed temporary debt.',
        policySha256: reviewedPolicySha256,
      },
    };

    expect(() =>
      auditModule.compareAuditAdvisories(
        baseline,
        { ...acceptedPolicy, expires: '2026-10-31' },
        report
      )
    ).toThrow(/review|digest|policy|expiry/i);
  });
});
