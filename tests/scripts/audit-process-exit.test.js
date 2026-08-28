import { describe, expect, it } from 'vitest';
import * as auditModule from '../../scripts/check-audit-baseline.mjs';

describe('npm audit process exit handling', () => {
  it('accepts normal audit exits and rejects abnormal termination', () => {
    expect(typeof auditModule.validateAuditProcessResult).toBe('function');
    if (typeof auditModule.validateAuditProcessResult !== 'function') return;

    expect(() =>
      auditModule.validateAuditProcessResult({ status: 0, signal: null })
    ).not.toThrow();
    expect(() =>
      auditModule.validateAuditProcessResult({ status: 1, signal: null })
    ).not.toThrow();
    expect(() =>
      auditModule.validateAuditProcessResult({ status: 2, signal: null })
    ).toThrow(/exit|status|2/i);
    expect(() =>
      auditModule.validateAuditProcessResult({ status: null, signal: 'SIGTERM' })
    ).toThrow(/signal|terminated|SIGTERM/i);
  });
});
