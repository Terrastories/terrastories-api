import { describe, expect, it } from 'vitest';
import { extractSignedSessionCookie } from './session-cookie.js';

describe('extractSignedSessionCookie', () => {
  it('selects the signed session cookie regardless of header ordering', () => {
    const unsigned = 'sessionId=short; Path=/; HttpOnly';
    const signed = 'sessionId=longer-signed-value.signature; Path=/; HttpOnly';

    expect(extractSignedSessionCookie([unsigned, signed])).toBe(signed);
    expect(extractSignedSessionCookie([signed, unsigned])).toBe(signed);
  });

  it('fails closed when no sessionId cookie exists', () => {
    expect(() => extractSignedSessionCookie(['other=value; Path=/'])).toThrow(
      /Failed to extract session cookie/
    );
  });
});
