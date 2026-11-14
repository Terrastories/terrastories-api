import { describe, expect, it } from 'vitest';
import {
  InvalidV2RoleError,
  V2_COMMUNITY_ROLES,
  fastifyRoleToV2Role,
  parseV2Role,
  requireV2Role,
} from '../../src/shared/authorization/sovereignty-policy.js';

describe('V2-boundary role parser (parseV2Role / requireV2Role)', () => {
  it('accepts strictly the five canonical V2 roles and distinguishes viewer from member', () => {
    expect(V2_COMMUNITY_ROLES).toEqual([
      'viewer',
      'member',
      'editor',
      'admin',
      'super_admin',
    ]);
    for (const role of V2_COMMUNITY_ROLES) {
      expect(parseV2Role(role)).toBe(role);
      expect(requireV2Role(role)).toBe(role);
    }
    expect(fastifyRoleToV2Role('viewer')).toBe('member');
    expect(parseV2Role('viewer')).toBe('viewer');
  });

  it('rejects elder and any invalid/non-canonical value fail-closed', () => {
    const invalid: unknown[] = [
      'elder',
      '',
      ' ',
      'viewer ',
      ' viewer',
      'Viewer',
      'MEMBER',
      'SUPER_ADMIN',
      'super-admin',
      'moderator',
      'toString',
      'constructor',
      '__proto__',
      null,
      undefined,
      0,
      true,
      {},
      ['viewer'],
    ];
    for (const input of invalid) {
      expect(parseV2Role(input)).toBeNull();
      expect(() => requireV2Role(input)).toThrow(InvalidV2RoleError);
    }
  });
});
