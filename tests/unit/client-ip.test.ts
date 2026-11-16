import { describe, expect, it } from 'vitest';
import { clientIpOf } from '../../src/shared/auth-policy.js';

/**
 * The per-IP throttle keys on one client address per request. Under
 * TRUSTED_PROXY, only the rightmost X-Forwarded-For entry — the one the
 * trusted proxy appended — is usable in a multi-hop chain; a leftmost entry is
 * caller-controlled noise. x-real-ip, when a proxy sets it, is the proxy's
 * own view of the client and wins over the chain.
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

  it('wins x-real-ip over the chain when the proxy sets it', () => {
    const headers = h(['198.51.100.1', '203.0.113.2']);
    headers.set('x-real-ip', '203.0.113.9');
    expect(clientIpOf(headers, { trustProxy: true })).toBe('203.0.113.9');
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

  it('becomes the unknown bucket when nothing usable exists', () => {
    expect(clientIpOf(new Headers(), {})).toBe('unknown');
  });
});
