export function extractSignedSessionCookie(
  setCookieHeader: string | string[] | undefined
): string {
  const sessionCookies = (
    Array.isArray(setCookieHeader)
      ? setCookieHeader
      : setCookieHeader
        ? [setCookieHeader]
        : []
  ).filter((cookie) => cookie.startsWith('sessionId='));

  if (sessionCookies.length === 0) {
    throw new Error('Failed to extract session cookie from login response');
  }

  // @fastify/session may emit more than one sessionId cookie. The signed value
  // contains the signature and is therefore longer; choose it deterministically
  // instead of relying on Set-Cookie header ordering.
  return [...sessionCookies].sort((left, right) => {
    const lengthDifference = right.length - left.length;
    return lengthDifference || left.localeCompare(right);
  })[0];
}
