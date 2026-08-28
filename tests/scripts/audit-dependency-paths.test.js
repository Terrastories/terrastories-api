import { describe, expect, it } from 'vitest';
import * as auditModule from '../../scripts/check-audit-baseline.mjs';

describe('npm audit remediation diagnostics', () => {
  it('preserves and reports exact affected dependency paths', () => {
    const report = {
      vulnerabilities: {
        'new-package': {
          nodes: [
            'node_modules/new-package',
            'node_modules/parent/node_modules/new-package',
          ],
          via: [
            {
              source: 'GHSA-example',
              severity: 'high',
              url: 'https://example.invalid/GHSA-example',
            },
          ],
        },
      },
    };

    const [advisory] = auditModule.collectAdvisories(report);

    expect(advisory.nodes).toEqual([
      'node_modules/new-package',
      'node_modules/parent/node_modules/new-package',
    ]);
    expect(typeof auditModule.formatAdvisoryDiagnostic).toBe('function');
    const diagnostic = auditModule.formatAdvisoryDiagnostic(advisory);
    expect(diagnostic).toContain('node_modules/new-package');
    expect(diagnostic).toContain(
      'node_modules/parent/node_modules/new-package'
    );
  });
});
