/**
 * Safe HTML description sanitiser and deterministic plain-text projection
 * (docs/SPEC-V2.md §6.9).
 *
 * Library choice: `hast-util-from-html` (backed by `parse5`) +
 * `hast-util-sanitize` + `hast-util-to-html`.
 * - Runs identically on Node.js and Cloudflare Workers (`workerd`) with zero
 *   DOM/jsdom dependencies and zero Node built-in imports.
 * - Uses a real WHATWG HTML5 parser (`parse5`) for spec-compliant HTML entity
 *   decoding, malformed/unclosed tag recovery, and mXSS resistance across
 *   foreign content (`<svg>`, `<math>`).
 * - Rejected alternatives: `sanitize-html` pulls in `postcss`, which imports
 *   Node's `path` built-in and fails Workers bundling; `xss` (`js-xss`) uses
 *   a regex/string scanner that leaks `[removed]` markers on nested stripped
 *   tags (`<svg><script>...</script></svg>`), misparses `<a/href=...>`, drops
 *   literal `< ... >` text spans, and lacks full HTML5 named-entity decoding.
 * - `hast-util-sanitize` enforces the closed tag/attribute allowlist and strips
 *   scripts, styles, comments, and embedded media with their contents; this
 *   module then validates every `<a href>` with the global WHATWG `URL` parser
 *   and sets `rel="noopener noreferrer nofollow"` (never `target`).
 *
 * Cultural content invariant: never log or embed description content, raw
 * HTML, plain-text projections, or offending `href` values in errors.
 */

import { fromHtml } from 'hast-util-from-html';
import { sanitize, type Schema } from 'hast-util-sanitize';
import { toHtml, type Options as ToHtmlOptions } from 'hast-util-to-html';
import {
  InvalidDescriptionError,
  type InvalidDescriptionReason,
} from '../errors/index.js';

export { InvalidDescriptionError, type InvalidDescriptionReason };

/** Maximum permitted character length of sanitised HTML (and plain-text projection). */
export const DESCRIPTION_MAX_LENGTH = 20_000;

const ALLOWED_TAGS = [
  'strong',
  'b',
  'em',
  'i',
  'a',
  'ul',
  'ol',
  'li',
  'p',
  'br',
] as const;

const STRIPPED_TAGS = [
  'script',
  'style',
  'noscript',
  'template',
  'title',
  'textarea',
  'xmp',
  'noembed',
  'noframes',
  'plaintext',
  'head',
  'svg',
  'math',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'video',
  'audio',
  'canvas',
  'picture',
  'source',
  'track',
  'map',
  'area',
  'param',
  'portal',
  'img',
] as const;

const STRIPPED_TAG_SET: ReadonlySet<string> = new Set(STRIPPED_TAGS);

const BLOCK_OR_BREAK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'ul',
  'ol',
  'li',
  'div',
  'blockquote',
  'pre',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'tr',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'dt',
  'dd',
]);

const ALLOWED_HREF_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
]);

const LINK_REL: string[] = ['noopener', 'noreferrer', 'nofollow'];

/**
 * Override every defaultSchema key so GitHub defaults (such as `*` attributes,
 * `protocols`, or `clobber`) never leak into the description allowlist.
 * `protocols` is intentionally empty because `transformAnchorNodes` parses and
 * validates every `href` through the WHATWG `URL` global after entity decoding.
 */
const SANITIZE_SCHEMA: Schema = {
  ancestors: {},
  attributes: { a: ['href'] },
  clobber: [],
  clobberPrefix: '',
  protocols: {},
  required: {},
  strip: [...STRIPPED_TAGS],
  tagNames: [...ALLOWED_TAGS],
  allowComments: false,
  allowDoctypes: false,
};

const TO_HTML_OPTIONS: ToHtmlOptions = {
  characterReferences: { useNamedReferences: true },
};

type HastRoot = ReturnType<typeof fromHtml>;
type HastRootContent = HastRoot['children'][number];
type HastElement = Extract<HastRootContent, { type: 'element' }>;

export interface SanitizeDescriptionResult {
  html: string;
  changed: boolean;
}

export interface SanitizeDescriptionMigrationResult {
  html: string;
  changed: boolean;
  droppedHrefs: number;
  exceedsMaxLength: boolean;
}

export interface ValidatedDescriptionResult {
  html: string;
  plainText: string;
  changed: boolean;
}

function assertStringInput(input: unknown): asserts input is string {
  if (typeof input !== 'string') {
    throw new InvalidDescriptionError(
      'INVALID_TYPE',
      'Description must be a string'
    );
  }
}

/**
 * Parse an already entity-decoded `href` value under WHATWG `URL` rules.
 * Accepts only absolute `http:`, `https:`, and non-empty `mailto:` URLs;
 * rejects relative, protocol-relative (`//`), fragment-only (`#`), and all
 * other schemes.
 */
function parseAllowedHref(rawHref: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawHref);
  } catch {
    return null;
  }

  if (!ALLOWED_HREF_PROTOCOLS.has(parsed.protocol)) {
    return null;
  }

  if (
    parsed.protocol === 'mailto:' &&
    parsed.pathname.length === 0 &&
    parsed.search.length === 0
  ) {
    return null;
  }

  return parsed.href;
}

function isElementNode(node: HastRootContent): node is HastElement {
  return node.type === 'element';
}

function transformChildren(
  children: HastElement['children'],
  mode: 'runtime' | 'migration',
  state: { droppedHrefs: number }
): HastElement['children'] {
  const result: HastElement['children'] = [];

  for (const child of children) {
    if (!isElementNode(child)) {
      result.push(child);
      continue;
    }

    child.children = transformChildren(child.children, mode, state);

    if (child.tagName !== 'a') {
      child.properties = {};
      result.push(child);
      continue;
    }

    const props = child.properties ?? {};
    const hasHref = Object.prototype.hasOwnProperty.call(props, 'href');

    if (!hasHref) {
      // Unwrap anchor tags that carry no href (e.g. legacy `<a name="...">` or
      // anchors whose only attributes were disallowed) while keeping their text.
      result.push(...child.children);
      continue;
    }

    const rawHref = props.href;
    const validHref =
      typeof rawHref === 'string' ? parseAllowedHref(rawHref) : null;

    if (validHref === null) {
      if (mode === 'runtime') {
        throw new InvalidDescriptionError(
          'INVALID_HREF',
          'Description link href must use an absolute http:, https:, or mailto: URL'
        );
      }
      state.droppedHrefs += 1;
      result.push(...child.children);
      continue;
    }

    child.properties = {
      href: validHref,
      rel: LINK_REL,
    };
    result.push(child);
  }

  return result;
}

function runSanitiser(
  input: string,
  mode: 'runtime' | 'migration'
): { html: string; changed: boolean; droppedHrefs: number } {
  assertStringInput(input);
  if (input === '') {
    return { html: '', changed: false, droppedHrefs: 0 };
  }

  const parsed = fromHtml(input, { fragment: true });
  const sanitized = sanitize(parsed, SANITIZE_SCHEMA);
  const state = { droppedHrefs: 0 };

  if ('children' in sanitized && Array.isArray(sanitized.children)) {
    sanitized.children = transformChildren(
      sanitized.children as HastElement['children'],
      mode,
      state
    ) as HastRoot['children'];
  }

  const html = toHtml(sanitized, TO_HTML_OPTIONS);
  return {
    html,
    changed: html !== input,
    droppedHrefs: state.droppedHrefs,
  };
}

/**
 * Sanitise a description for runtime writes under SPEC-V2 §6.9.
 * Strips disallowed tags and attributes, removes scripts/styles/comments/media
 * with content, adds `rel="noopener noreferrer nofollow"` on valid links, and
 * rejects non-conforming `href` values with `InvalidDescriptionError`.
 */
export function sanitizeDescription(input: string): SanitizeDescriptionResult {
  const { html, changed } = runSanitiser(input, 'runtime');
  return { html, changed };
}

/**
 * Sanitise a legacy description during data migration under SPEC-V2 §6.9.
 * Applies the same allowlist rules as `sanitizeDescription` but drops any
 * non-conforming `href` while keeping the anchor's text instead of rejecting.
 */
export function sanitizeDescriptionForMigration(
  input: string
): SanitizeDescriptionMigrationResult {
  const { html, changed, droppedHrefs } = runSanitiser(input, 'migration');
  return {
    html,
    changed,
    droppedHrefs,
    exceedsMaxLength: html.length > DESCRIPTION_MAX_LENGTH,
  };
}

/**
 * Validate and sanitise a description for runtime writes (SPEC-V2 §6.9).
 * Rejects non-conforming `href` values and over-length sanitised HTML
 * (`> DESCRIPTION_MAX_LENGTH`) with `InvalidDescriptionError` — never truncates.
 */
export function validateDescriptionForWrite(
  input: string
): ValidatedDescriptionResult {
  const { html, changed } = sanitizeDescription(input);

  if (html.length > DESCRIPTION_MAX_LENGTH) {
    throw new InvalidDescriptionError(
      'MAX_LENGTH_EXCEEDED',
      `Description exceeds maximum length of ${DESCRIPTION_MAX_LENGTH} characters`,
      {
        maxLength: DESCRIPTION_MAX_LENGTH,
        actualLength: html.length,
      }
    );
  }

  const plainText = descriptionPlainText(html);
  return { html, plainText, changed };
}

/**
 * Deterministic plain-text projection of a description (SPEC-V2 §6.9):
 * all tags stripped, HTML character entities decoded, and the same
 * `DESCRIPTION_MAX_LENGTH` cap enforced without truncation.
 */
export function descriptionPlainText(html: string): string {
  assertStringInput(html);
  if (html === '') {
    return '';
  }

  const tree = fromHtml(html, { fragment: true });
  let output = '';
  let pendingSpace = false;

  const endsWithWhitespace = (value: string): boolean =>
    value.length === 0 || /\s$/.test(value);
  const startsWithWhitespace = (value: string): boolean =>
    value.length > 0 && /^\s/.test(value);

  const walk = (nodes: HastRoot['children']): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const text = node.value;
        if (text.length === 0) continue;
        if (
          pendingSpace &&
          output.length > 0 &&
          !endsWithWhitespace(output) &&
          !startsWithWhitespace(text)
        ) {
          output += ' ';
        }
        pendingSpace = false;
        output += text;
        continue;
      }

      if (node.type !== 'element') {
        continue;
      }

      if (STRIPPED_TAG_SET.has(node.tagName)) {
        continue;
      }

      if (node.tagName === 'br') {
        if (output.length > 0) {
          pendingSpace = true;
        }
        continue;
      }

      const isBlock = BLOCK_OR_BREAK_TAGS.has(node.tagName);
      if (isBlock && output.length > 0) {
        pendingSpace = true;
      }

      walk(node.children as HastRoot['children']);

      if (isBlock && output.length > 0) {
        pendingSpace = true;
      }
    }
  };

  walk(tree.children);

  if (output.length > DESCRIPTION_MAX_LENGTH) {
    throw new InvalidDescriptionError(
      'MAX_LENGTH_EXCEEDED',
      `Description plain-text projection exceeds maximum length of ${DESCRIPTION_MAX_LENGTH} characters`,
      {
        maxLength: DESCRIPTION_MAX_LENGTH,
        actualLength: output.length,
      }
    );
  }

  return output;
}
