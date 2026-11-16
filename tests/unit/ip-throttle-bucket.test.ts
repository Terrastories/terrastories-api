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

  it('parses an embedded IPv4 tail and still folds onto the /64', () => {
    expect(ipThrottleBucket('::ffff:192.0.2.1')).toBe('0:0:0:0::/64');
    expect(ipThrottleBucket('::ffff:192.0.2.254')).toBe('0:0:0:0::/64');
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
    expect(ipThrottleBucket('::')).toBe('0:0:0:0::/64');
    expect(ipThrottleBucket('::1')).toBe('0:0:0:0::/64');
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
