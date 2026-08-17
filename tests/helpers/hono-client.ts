/**
 * Hono Test Helpers
 *
 * Creates Hono apps for testing using the in-memory SQLite database.
 * Uses Hono's built-in app.request() for in-process testing.
 */

import { Hono } from 'hono';
import { buildHonoApp } from '../../src/hono-app.js';
import type { TestDatabase } from './database.js';

export type HonoTestApp = Hono;

/**
 * Create a Hono test app with the provided test database.
 */
export async function createHonoTestApp(
  testDatabase?: TestDatabase
): Promise<HonoTestApp> {
  return await buildHonoApp({
    database: testDatabase,
  });
}

/**
 * Make an authenticated request to the Hono app.
 * Uses a session cookie for authentication.
 */
export async function honoRequest(
  app: HonoTestApp,
  method: string,
  path: string,
  options?: {
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  }
): Promise<{
  status: number;
  body: unknown;
  headers: Record<string, string>;
}> {
  const headers: Record<string, string> = {
    ...options?.headers,
  };

  if (options?.cookie) {
    headers['cookie'] = options.cookie;
  }

  let requestBody: string | undefined;
  if (options?.body !== undefined) {
    headers['content-type'] = 'application/json';
    requestBody = JSON.stringify(options.body);
  }

  const response = await app.request(path, {
    method: method.toUpperCase(),
    headers,
    body: requestBody,
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  let responseBody: unknown;
  const text = await response.text();
  try {
    responseBody = JSON.parse(text);
  } catch {
    responseBody = text;
  }

  return {
    status: response.status,
    body: responseBody,
    headers: responseHeaders,
  };
}

/**
 * Extract session cookie from a login response's set-cookie header.
 * Returns the full cookie string for use in subsequent requests.
 */
export function extractSessionCookie(
  headers: Record<string, string>
): string | null {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;

  // Hono returns a single set-cookie header value
  // Extract the sessionId cookie
  const match = setCookie.match(/sessionId=([^;]+)/);
  return match ? `sessionId=${match[1]}` : null;
}

/**
 * Login to the Hono app and return the session cookie.
 */
export async function honoLogin(
  app: HonoTestApp,
  email: string,
  password: string,
  communityId?: number
): Promise<string> {
  const response = await honoRequest(app, 'POST', '/v2/auth/login', {
    body: { email, password, communityId },
  });

  if (response.status !== 200) {
    throw new Error(
      `Login failed: ${response.status} ${JSON.stringify(response.body)}`
    );
  }

  const cookie = extractSessionCookie(response.headers);
  if (!cookie) {
    throw new Error('No session cookie in login response');
  }

  return cookie;
}
