import { describe, expect, it } from 'vitest';
import { clientIpOf } from '../../src/shared/auth-policy.js';

/**
 * The per-IP throttle keys on one client address per request. Under
 * TRUSTED_PROXY, only the rightmost X-Forwarded-For entry — the one the
 * trusted proxy appended — is usable in a multi-hop chain; a leftmost entry is
 * caller-controlled noise. x-real-ip is ignored entirely unless the operator
 * explicitly names it as the proxy's client-address header
 * (`TRUSTED_PROXY_HEADER=x-real-ip`), because a client can set that header
 * itself (or pass through a proxy that merely forwards it).
 */
describe('clientIpOf', () => {
  const h = (entries: string[]) => {
    const headers = new Headers();
    if (entries.length > 0) headers.set('x-forwarded-for', entries.join(', '));
    return headers;
  };

  it('takes the rightmost X-Forwarded-For entry under a trusted proxy', () => {
    expect(
      clientIpOf(h(['198.51.100.1', '203.0.113.2']), { trustProxy: true })
    ).toBe('203.0.113.2');
  });

  it('is not steerable by stuffing the leftmost entry', () => {
    expect(
      clientIpOf(h(['203.0.113.66', '192.0.2.1', '198.51.100.77']), {
        trustProxy: true,
      })
    ).toBe('198.51.100.77');
  });

  it('ignores x-real-ip by default: a spoofable header must not win', () => {
    const headers = h(['198.51.100.1', '203.0.113.2']);
    headers.set('x-real-ip', '203.0.113.66');
    expect(clientIpOf(headers, { trustProxy: true })).toBe('203.0.113.2');
    // An unusable default-world X-Real-IP must not outrank the chain either.
    headers.set('x-real-ip', 'not-an-ip');
    expect(clientIpOf(headers, { trustProxy: true })).toBe('203.0.113.2');
  });

  it('honours x-real-ip only with the explicit setting', () => {
    const headers = h(['198.51.100.1', '203.0.113.2']);
    headers.set('x-real-ip', '203.0.113.9');
    expect(
      clientIpOf(headers, {
        trustProxy: true,
        trustedProxyHeader: 'x-real-ip',
      })
    ).toBe('203.0.113.9');
  });

  it('falls back to the chain when the explicitly named proxy header is unusable', () => {
    const headers = h(['198.51.100.1', '203.0.113.2']);
    headers.set('x-real-ip', 'x'.repeat(65));
    expect(
      clientIpOf(headers, {
        trustProxy: true,
        trustedProxyHeader: 'x-real-ip',
      })
    ).toBe('203.0.113.2');
    headers.delete('x-real-ip');
    expect(
      clientIpOf(headers, {
        trustProxy: true,
        trustedProxyHeader: 'x-real-ip',
      })
    ).toBe('203.0.113.2');
  });

  it('falls back to the socket peer when the proxy sends nothing usable', () => {
    expect(
      clientIpOf(new Headers(), {
        trustProxy: true,
        remoteAddress: '198.51.100.4',
      })
    ).toBe('198.51.100.4');
    // An over-length header line is not usable, so the socket peer answers.
    expect(
      clientIpOf(h(['x'.repeat(65)]), {
        trustProxy: true,
        remoteAddress: '198.51.100.4',
      })
    ).toBe('198.51.100.4');
  });

  it('honours cf-connecting-ip only on Workers', () => {
    const headers = new Headers();
    headers.set('cf-connecting-ip', '203.0.113.3');
    expect(clientIpOf(headers, { isWorkers: true })).toBe('203.0.113.3');
    expect(clientIpOf(headers, { isWorkers: false, trustProxy: true })).toBe(
      'unknown'
    );
  });

  it('honours only syntactically valid IPv4/IPv6 addresses', () => {
    // IPv6 accepted with and without compression; IPv4-mapped and ::1 work.
    expect(clientIpOf(h(['2001:db8::1']), { trustProxy: true })).toBe(
      '2001:db8::1'
    );
    expect(clientIpOf(h(['::1']), { trustProxy: true })).toBe('::1');
    expect(clientIpOf(h(['::ffff:192.0.2.1']), { trustProxy: true })).toBe(
      '::ffff:192.0.2.1'
    );
    expect(clientIpOf(h(['1.2.3.4']), { trustProxy: true })).toBe('1.2.3.4');
    // Out-of-range octets and malformed groups fall back to the socket peer.
    for (const bogus of [
      '256.1.1.1',
      '999.1.1.1',
      '1.2.3.256',
      'not-an-ip',
      'garbage',
      'gg::1',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1%eth0',
      '1.2.3',
      '192.168.1.1,',
    ]) {
      expect(
        clientIpOf(h([bogus]), {
          trustProxy: true,
          remoteAddress: '198.51.100.4',
        }),
        `expected ${bogus} to fall back to the socket peer`
      ).toBe('198.51.100.4');
    }
    // Garbage in x-real-ip with the explicit header set still falls back.
    const headers = new Headers();
    headers.set('x-forwarded-for', '198.51.100.7');
    headers.set('x-real-ip', 'not-an-ip');
    expect(
      clientIpOf(headers, { trustProxy: true, trustedProxyHeader: 'x-real-ip' })
    ).toBe('198.51.100.7');
    // And garbage everywhere becomes the unknown bucket.
    expect(clientIpOf(h(['not-an-ip']), { trustProxy: true })).toBe('unknown');
  });

  it('becomes the unknown bucket when nothing usable exists', () => {
    expect(clientIpOf(new Headers(), {})).toBe('unknown');
  });
});
