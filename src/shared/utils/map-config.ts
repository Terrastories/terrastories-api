/**
 * Pure validation and sanitization helpers for per-community Mapbox and
 * Protomaps map configuration (SPEC-V2 §6.6).
 *
 * Zero Node-only or database imports so Workers, Node.js, and unit tests
 * enforce identical rules.
 */

export const MAPBOX_STYLE_URL_MAX_LENGTH = 2048;
export const MAPBOX_ACCESS_TOKEN_MAX_LENGTH = 512;
export const PROTOMAPS_API_KEY_MAX_LENGTH = 256;
export const PROTOMAPS_BASEMAP_STYLE_MAX_LENGTH = 120;

/**
 * Query parameter names (lowercased with `-` and `_` stripped) that can carry
 * provider or signed-URL credentials.
 */
export const MAP_CONFIG_CREDENTIAL_PARAM_NAMES = new Set([
  'accesstoken',
  'token',
  'apikey',
  'key',
  'secret',
  'sig',
  'signature',
  'keypairid',
  'xamzsignature',
  'xamzcredential',
  'xamzsecuritytoken',
  'xgoogsignature',
  'xgoogcredential',
]);

const MAPBOX_STYLE_SCHEME_PATTERN =
  /^mapbox:\/\/styles\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const PUBLIC_MAPBOX_TOKEN_PATTERN = /^pk\.[A-Za-z0-9._-]+$/;
const SECRET_MAPBOX_TOKEN_PREFIX = /^sk\./i;

export function hasCredentialQueryParam(parsed: URL): boolean {
  for (const paramName of parsed.searchParams.keys()) {
    if (
      MAP_CONFIG_CREDENTIAL_PARAM_NAMES.has(
        paramName.toLowerCase().replace(/[-_]/g, '')
      )
    ) {
      return true;
    }
  }
  return false;
}

export function isSecretMapboxToken(value: string): boolean {
  return SECRET_MAPBOX_TOKEN_PREFIX.test(value.trim());
}

export function isPublicMapboxToken(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAPBOX_ACCESS_TOKEN_MAX_LENGTH &&
    PUBLIC_MAPBOX_TOKEN_PATTERN.test(trimmed)
  );
}

/**
 * Defense-in-depth projection helper: only a well-formed public Mapbox token
 * (`pk.*`) can ever leave the API. Secret (`sk.*`) or malformed strings yield
 * `null`.
 */
export function sanitizePublicMapboxToken(
  value: string | null | undefined
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isPublicMapboxToken(trimmed) ? trimmed : null;
}

/**
 * Validates and normalizes `mapboxStyleUrl`: accepts `mapbox://styles/<owner>/<id>`
 * or credential-free `https://...` URLs without embedded userinfo, fragments,
 * or credential query params. Rejects `http://` and everything else as `null`.
 */
export function sanitizeMapboxStyleUrl(
  value: string | null | undefined
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAPBOX_STYLE_URL_MAX_LENGTH) {
    return null;
  }
  if (/^mapbox:\/\//i.test(trimmed)) {
    return MAPBOX_STYLE_SCHEME_PATTERN.test(trimmed) ? trimmed : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    return null;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.hash !== '') {
    return null;
  }
  if (hasCredentialQueryParam(parsed)) {
    return null;
  }
  return trimmed;
}

export function isValidProtomapsApiKey(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length >= 1 &&
    trimmed.length <= PROTOMAPS_API_KEY_MAX_LENGTH &&
    !/[\s\r\n\0]/.test(trimmed)
  );
}
