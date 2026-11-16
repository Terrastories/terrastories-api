import { describe, expect, it } from 'vitest';
import {
  AUTH_THROTTLE_KEY_IP,
  ipThrottleBucket,
} from '../../src/shared/auth-policy.js';
import { sha256Hex } from '../../src/shared/auth-crypto.js';

describe('ipThrottleBucket', () => {
  it('uses an IPv4 address verbatim', () => {
    expect(ipThrottleBucket('198.51.100.7')).toBe('198.51.100.7');
    expect(ipThrottleBucket('10.0.0.255')).toBe('10.0.0.255');
  });

  it('folds an IPv6 address onto its /64 prefix', () => {
    expect(ipThrottleBucket('2001:db8:abcd:1234::1')).toBe(
      '2001:db8:abcd:1234::/64'
    );
    expect(ipThrottleBucket('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(ipThrottleBucket('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(ipThrottleBucket('2001:db8:abcd:1234:dead:beef:0:1')).toBe(
      '2001:db8:abcd:1234::/64'
    );
    expect(ipThrottleBucket('2001:db8:abcd:1234:9999:8888:7777:6666')).toBe(
      '2001:db8:abcd:1234::/64'
    );
  });

  it('is IPv6 representation- and case-invariant', () => {
    expect(ipThrottleBucket('2001:DB8:ABCD:1234:0:0:0:1')).toBe(
      '2001:db8:abcd:1234::/64'
    );
    expect(ipThrottleBucket('2001:0db8:abcd:1234::ffff')).toBe(
      '2001:db8:abcd:1234::/64'
    );
    expect(ipThrottleBucket('2001:db8:abcd::')).toBe('2001:db8:abcd:0::/64');
  });

  it('keeps distinct IPv6 /64 prefixes in distinct buckets', () => {
    expect(ipThrottleBucket('2001:db8:abcd:1234::1')).not.toBe(
      ipThrottleBucket('2001:db8:abcd:9999::1')
    );
    expect(ipThrottleBucket('2001:db8:abcd:1234::/64')).toBe(
      '2001:db8:abcd:1234::/64'
    );
  });

  it('unwraps an IPv4-mapped tail and keys it as its IPv4 address', () => {
    // The mapped form keys exactly like the plain IPv4 address, so no client
    // is billed to two buckets and the whole mapped population never shares
    // one row.
    expect(ipThrottleBucket('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(ipThrottleBucket('::ffff:198.51.100.9')).toBe('198.51.100.9');
    expect(ipThrottleBucket('::ffff:192.0.2.1')).toBe(
      ipThrottleBucket('192.0.2.1')
    );
    expect(ipThrottleBucket('::ffff:192.0.2.254')).toBe(
      ipThrottleBucket('192.0.2.254')
    );
    // The bare-hex form (`::ffff:cb00:7105`) keys identically.
    expect(ipThrottleBucket('::ffff:cb00:7105')).toBe('203.0.113.5');
    // Distinct addresses get distinct keys.
    expect(ipThrottleBucket('::ffff:203.0.113.5')).not.toBe(
      ipThrottleBucket('::ffff:198.51.100.9')
    );
  });

  it('unwraps IPv4-compatible addresses but not ::/::1', () => {
    expect(ipThrottleBucket('::192.0.2.1')).toBe('192.0.2.1');
    expect(ipThrottleBucket('::192.0.2.254')).toBe('192.0.2.254');
    expect(ipThrottleBucket('::c000:201')).toBe('192.0.2.1');
    expect(ipThrottleBucket('::')).toBe('::');
    expect(ipThrottleBucket('::1')).toBe('::1');
    expect(ipThrottleBucket('::1')).not.toBe(ipThrottleBucket('::'));
  });

  it('folds a mapped-form /64-like range no differently from any other', () => {
    expect(ipThrottleBucket('2001:db8::1.2.3.4')).toBe('2001:db8:0:0::/64');
    expect(ipThrottleBucket('2001:db8::5.6.7.8')).toBe('2001:db8:0:0::/64');
  });

  it('canonicalizes without dropping the IPv6 distinctness of neighbouring groups', () => {
    expect(ipThrottleBucket('2001:db8:abcd:1234:0:0:0:ffff')).toBe(
      '2001:db8:abcd:1234::/64'
    );
    expect(ipThrottleBucket('2001:db8:abcd:1235::1')).not.toBe(
      ipThrottleBucket('2001:db8:abcd:1234::1')
    );
  });

  it('passes a non-IP bucket string through unchanged', () => {
    expect(ipThrottleBucket('unknown')).toBe('unknown');
  });

  it('makes the keyed hash of two IPv6 addresses in one /64 equal', async () => {
    const bucketA = ipThrottleBucket('2001:db8:abcd:1234::1');
    const bucketB = ipThrottleBucket('2001:db8:abcd:1234:ffff::');
    expect(bucketA).toBe(bucketB);
    const hashA = await sha256Hex(`${AUTH_THROTTLE_KEY_IP}${bucketA}`);
    const hashB = await sha256Hex(`${AUTH_THROTTLE_KEY_IP}${bucketB}`);
    expect(hashA).toBe(hashB);
    // Sibling /64 → different bucket and hash.
    const hashC = await sha256Hex(
      `${AUTH_THROTTLE_KEY_IP}${ipThrottleBucket('2001:db8:abcd:ef00::1')}`
    );
    expect(hashC).not.toBe(hashA);
  });
});
