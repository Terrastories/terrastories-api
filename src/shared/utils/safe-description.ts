/**
 * Safe HTML description sanitiser and deterministic plain-text projection
 * (docs/SPEC-V2.md §6.9).
 *
 * Length unit: `DESCRIPTION_MAX_LENGTH` (20,000) is counted in Unicode code
 * points (matching SPEC-V2 §6.9 "characters" and PostgreSQL `char_length`),
 * not UTF-16 code units. A pre-parse raw bound (`DESCRIPTION_MAX_RAW_LENGTH` =
 * 4 * `DESCRIPTION_MAX_LENGTH` UTF-16 code units) and an iterative post-parse
 * nesting-depth bound (`MAX_NESTING_DEPTH` = 128) protect against parser DoS.
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

/**
 * Maximum permitted length of sanitised HTML (and plain-text projection),
 * measured in Unicode code points per SPEC-V2 §6.9.
 */
export const DESCRIPTION_MAX_LENGTH = 20_000;

/**
 * Pre-parse raw input bound in UTF-16 code units to bound parser CPU/memory
 * before HTML5 tree construction runs.
 */
export const DESCRIPTION_MAX_RAW_LENGTH = 4 * DESCRIPTION_MAX_LENGTH;

/** Maximum permitted element nesting depth after HTML5 parsing. */
export const MAX_NESTING_DEPTH = 128;

/** Maximum re-parse stabilisation passes after initial serialisation. */
const MAX_IDEMPOTENCE_PASSES = 3;

declare const plainTextBrand: unique symbol;

/**
 * Decoded, unescaped plain-text projection of a sanitised description, for
 * search indexing and plain-text contexts only.
 *
 * @security NEVER insert `PlainText` into HTML, `innerHTML`, or unescaped
 * markup templates — HTML entities such as `&lt;script&gt;` are decoded to
 * literal `<script>` characters, which creates an XSS vulnerability if
 * rendered as HTML.
 */
export type PlainText = string & { readonly [plainTextBrand]: true };

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

/**
 * Tags removed with their entire subtree (scripts, styles, and embedded media).
 * Text-bearing RCDATA/rawtext/fallback elements (`textarea`, `title`, `xmp`,
 * `noembed`, `noframes`, `noscript`, `template`, `plaintext`) are intentionally
 * NOT listed here so their text content is unwrapped and preserved safely.
 */
const STRIPPED_TAGS = [
  'script',
  'style',
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

const NON_ALLOWLISTED_BLOCK_TAGS: ReadonlySet<string> = new Set([
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'address',
  'details',
  'summary',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'caption',
  'tr',
  'td',
  'th',
  'fieldset',
  'legend',
  'hgroup',
]);

const BLOCK_OR_BREAK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'br',
  'ul',
  'ol',
  'li',
  ...NON_ALLOWLISTED_BLOCK_TAGS,
]);

const BLOCK_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'p',
  'ul',
  'ol',
  'li',
  ...NON_ALLOWLISTED_BLOCK_TAGS,
]);

const ALLOWED_HREF_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
]);

const LINK_REL: readonly string[] = Object.freeze([
  'noopener',
  'noreferrer',
  'nofollow',
]);

/**
 * Override every defaultSchema key so GitHub defaults (such as `*` attributes,
 * `protocols`, or `clobber`) never leak into the description allowlist.
 * `protocols` is intentionally empty because `transformChildren` parses and
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

export interface SanitizeDescriptionMigrationResult {
  html: string;
  changed: boolean;
  droppedHrefs: number;
  removedNodes: number;
  exceedsMaxLength: boolean;
}

export interface ValidatedDescriptionResult {
  html: string;
  plainText: PlainText;
  changed: boolean;
}

function isWellFormedUtf16(value: string): boolean {
  const withIsWellFormed = value as { isWellFormed?: () => boolean };
  if (typeof withIsWellFormed.isWellFormed === 'function') {
    return withIsWellFormed.isWellFormed();
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return false;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function countCodePoints(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
      }
    }
    count += 1;
  }
  return count;
}

function assertValidStringInput(input: unknown): asserts input is string {
  if (typeof input !== 'string') {
    throw new InvalidDescriptionError(
      'INVALID_TYPE',
      'Description must be a string'
    );
  }
  if (!isWellFormedUtf16(input)) {
    throw new InvalidDescriptionError(
      'INVALID_UNICODE',
      'Description must be well-formed Unicode without lone surrogates'
    );
  }
  if (input.length > DESCRIPTION_MAX_RAW_LENGTH) {
    throw new InvalidDescriptionError(
      'INPUT_TOO_LARGE',
      `Description raw input exceeds maximum size of ${DESCRIPTION_MAX_RAW_LENGTH} characters`,
      {
        maxLength: DESCRIPTION_MAX_RAW_LENGTH,
        actualLength: input.length,
      }
    );
  }
}

function tooComplexError(): InvalidDescriptionError {
  return new InvalidDescriptionError(
    'TOO_COMPLEX',
    'Description nesting or structure exceeds complexity limits'
  );
}

/**
 * Iteratively verify parsed HAST nesting depth does not exceed `maxDepth`.
 */
function assertMaxDepth(root: HastRoot, maxDepth: number): void {
  const stack: Array<{ node: HastRootContent; depth: number }> = [];
  for (let i = root.children.length - 1; i >= 0; i--) {
    stack.push({ node: root.children[i]!, depth: 1 });
  }

  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (node.type !== 'element') continue;
    if (depth > maxDepth) {
      throw tooComplexError();
    }
    const contentChildren = node.content?.children;
    if (contentChildren) {
      for (let i = contentChildren.length - 1; i >= 0; i--) {
        stack.push({ node: contentChildren[i]!, depth: depth + 1 });
      }
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push({ node: node.children[i]!, depth: depth + 1 });
    }
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

function hasNonWhitespaceText(rootElement: HastElement): boolean {
  const stack: HastRootContent[] = [...rootElement.children];
  if (rootElement.content?.children) {
    stack.push(...rootElement.content.children);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'text' && node.value.trim().length > 0) {
      return true;
    }
    if (node.type === 'element') {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push(node.children[i]!);
      }
      if (node.content?.children) {
        for (let i = node.content.children.length - 1; i >= 0; i--) {
          stack.push(node.content.children[i]!);
        }
      }
    }
  }
  return false;
}

/**
 * Iteratively count top-level stripped elements that contain non-whitespace
 * text so migrations can report removed text-bearing nodes for review.
 */
function countRemovedTextNodes(children: HastRoot['children']): number {
  let removed = 0;
  const stack: HastRootContent[] = [];
  for (let i = children.length - 1; i >= 0; i--) {
    stack.push(children[i]!);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== 'element') continue;
    if (STRIPPED_TAG_SET.has(node.tagName)) {
      if (hasNonWhitespaceText(node)) {
        removed += 1;
      }
      continue;
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]!);
    }
  }
  return removed;
}

function containsBlockElement(children: HastElement['children']): boolean {
  const stack: HastElement['children'] = [...children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type !== 'element') continue;
    if (BLOCK_CONTAINER_TAGS.has(node.tagName)) return true;
    if (STRIPPED_TAG_SET.has(node.tagName)) continue;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = node.children[i]!;
      if (child.type === 'element') {
        stack.push(child);
      }
    }
  }
  return false;
}

function isWhitespaceChar(char: string): boolean {
  return /\s/.test(char);
}

function endsWithInlineWithoutSpace(
  nodes: HastElement['children']
): boolean | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]!;
    if (node.type === 'text') {
      if (node.value.length === 0) continue;
      return !isWhitespaceChar(node.value[node.value.length - 1]!);
    }
    if (node.type !== 'element') continue;
    if (STRIPPED_TAG_SET.has(node.tagName)) continue;
    if (BLOCK_CONTAINER_TAGS.has(node.tagName) || node.tagName === 'br') {
      return false;
    }
    const inner = endsWithInlineWithoutSpace(node.children);
    if (inner !== null) return inner;
  }
  return null;
}

function startsWithInlineWithoutSpace(
  nodes: HastElement['children']
): boolean | null {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type === 'text') {
      if (node.value.length === 0) continue;
      return !isWhitespaceChar(node.value[0]!);
    }
    if (node.type !== 'element') continue;
    if (STRIPPED_TAG_SET.has(node.tagName)) continue;
    if (BLOCK_CONTAINER_TAGS.has(node.tagName) || node.tagName === 'br') {
      return false;
    }
    const inner = startsWithInlineWithoutSpace(node.children);
    if (inner !== null) return inner;
  }
  return null;
}

function appendNormalizedSlice(
  target: HastElement['children'],
  slice: HastElement['children'],
  fromUnwrappedBlock: boolean,
  pendingTrailingBoundary: boolean
): boolean {
  if (slice.length === 0) return pendingTrailingBoundary;

  const needsBoundaryCheck = fromUnwrappedBlock || pendingTrailingBoundary;
  if (
    needsBoundaryCheck &&
    endsWithInlineWithoutSpace(target) === true &&
    startsWithInlineWithoutSpace(slice) === true
  ) {
    target.push({ type: 'text', value: ' ' });
  }

  target.push(...slice);
  return fromUnwrappedBlock && endsWithInlineWithoutSpace(slice) === true;
}

/**
 * Pre-sanitise AST normalization:
 * - Unwrap `<template>` elements by promoting their `content` fragment so
 *   safe text/markup survives and nested `<script>`/media are stripped.
 * - Convert leaf non-allowlisted block elements (`div`, `h1`-`h6`, `td`, etc.)
 *   to `<p>`, and unwrap container block elements while preserving word
 *   boundaries so adjacent block/inline words never glue together.
 */
function normalizePreSanitize(
  children: HastElement['children']
): HastElement['children'] {
  const result: HastElement['children'] = [];
  let pendingTrailingBoundary = false;

  for (const child of children) {
    if (!isElementNode(child)) {
      pendingTrailingBoundary = appendNormalizedSlice(
        result,
        [child],
        false,
        pendingTrailingBoundary
      );
      continue;
    }

    if (STRIPPED_TAG_SET.has(child.tagName)) {
      pendingTrailingBoundary = appendNormalizedSlice(
        result,
        [child],
        false,
        pendingTrailingBoundary
      );
      continue;
    }

    if (child.tagName === 'template') {
      const templateChildren =
        child.content?.children && child.content.children.length > 0
          ? (child.content.children as HastElement['children'])
          : child.children;
      const normalized = normalizePreSanitize(templateChildren);
      pendingTrailingBoundary = appendNormalizedSlice(
        result,
        normalized,
        false,
        pendingTrailingBoundary
      );
      continue;
    }

    child.children = normalizePreSanitize(child.children);

    if (NON_ALLOWLISTED_BLOCK_TAGS.has(child.tagName)) {
      if (!containsBlockElement(child.children)) {
        child.tagName = 'p';
        child.properties = {};
        pendingTrailingBoundary = appendNormalizedSlice(
          result,
          [child],
          false,
          pendingTrailingBoundary
        );
      } else {
        pendingTrailingBoundary = appendNormalizedSlice(
          result,
          child.children,
          true,
          pendingTrailingBoundary
        );
      }
      continue;
    }

    pendingTrailingBoundary = appendNormalizedSlice(
      result,
      [child],
      false,
      pendingTrailingBoundary
    );
  }

  return result;
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
      rel: [...LINK_REL],
    };
    result.push(child);
  }

  return result;
}

function runSinglePass(
  input: string,
  mode: 'runtime' | 'migration'
): { html: string; droppedHrefs: number; removedNodes: number } {
  let parsed: HastRoot;
  try {
    parsed = fromHtml(input, { fragment: true });
    assertMaxDepth(parsed, MAX_NESTING_DEPTH);

    parsed.children = normalizePreSanitize(
      parsed.children as HastElement['children']
    ) as HastRoot['children'];

    const removedNodes = countRemovedTextNodes(parsed.children);
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
      droppedHrefs: state.droppedHrefs,
      removedNodes,
    };
  } catch (error) {
    if (error instanceof RangeError) {
      throw tooComplexError();
    }
    throw error;
  }
}

function runSanitiser(
  input: string,
  mode: 'runtime' | 'migration'
): {
  html: string;
  changed: boolean;
  droppedHrefs: number;
  removedNodes: number;
} {
  assertValidStringInput(input);
  if (input === '') {
    return { html: '', changed: false, droppedHrefs: 0, removedNodes: 0 };
  }

  const first = runSinglePass(input, mode);
  let currentHtml = first.html;
  let totalDroppedHrefs = first.droppedHrefs;
  let totalRemovedNodes = first.removedNodes;

  if (currentHtml !== input) {
    let stabilized = false;
    for (let pass = 0; pass < MAX_IDEMPOTENCE_PASSES; pass++) {
      if (currentHtml.length > DESCRIPTION_MAX_RAW_LENGTH) {
        throw new InvalidDescriptionError(
          'INPUT_TOO_LARGE',
          `Description expanded beyond maximum raw size of ${DESCRIPTION_MAX_RAW_LENGTH} characters`,
          {
            maxLength: DESCRIPTION_MAX_RAW_LENGTH,
            actualLength: currentHtml.length,
          }
        );
      }
      const next = runSinglePass(currentHtml, mode);
      totalDroppedHrefs += next.droppedHrefs;
      totalRemovedNodes += next.removedNodes;
      if (next.html === currentHtml) {
        stabilized = true;
        break;
      }
      currentHtml = next.html;
    }

    if (!stabilized) {
      throw tooComplexError();
    }
  }

  return {
    html: currentHtml,
    changed: currentHtml !== input,
    droppedHrefs: totalDroppedHrefs,
    removedNodes: totalRemovedNodes,
  };
}

/**
 * Sanitise a legacy description during data migration under SPEC-V2 §6.9.
 * Applies the same allowlist rules as `validateDescriptionForWrite` but drops
 * non-conforming `href` values while keeping anchor text instead of rejecting,
 * and reports `removedNodes` (stripped text-bearing elements) for human review.
 *
 * A legacy description must never block cutover (SPEC-V2 §6.9). This
 * function can still throw `InvalidDescriptionError` (`INPUT_TOO_LARGE`,
 * `TOO_COMPLEX`, `INVALID_TYPE`) on extreme input, and the migrator must
 * catch it and record a manual disposition for that row in the manifest
 * instead of aborting; the raw Rails value stays in the archive.
 */
export function sanitizeDescriptionForMigration(
  input: string
): SanitizeDescriptionMigrationResult {
  const { html, changed, droppedHrefs, removedNodes } = runSanitiser(
    input,
    'migration'
  );
  return {
    html,
    changed,
    droppedHrefs,
    removedNodes,
    exceedsMaxLength: countCodePoints(html) > DESCRIPTION_MAX_LENGTH,
  };
}

/**
 * Validate and sanitise a description for runtime writes (SPEC-V2 §6.9).
 * This is the sole exported runtime write entry point: it enforces the
 * allowlist, WHATWG URL `href` rules, idempotence, and the
 * `DESCRIPTION_MAX_LENGTH` code-point cap (never truncates).
 */
export function validateDescriptionForWrite(
  input: string
): ValidatedDescriptionResult {
  const { html, changed } = runSanitiser(input, 'runtime');

  const actualLength = countCodePoints(html);
  if (actualLength > DESCRIPTION_MAX_LENGTH) {
    throw new InvalidDescriptionError(
      'MAX_LENGTH_EXCEEDED',
      `Description exceeds maximum length of ${DESCRIPTION_MAX_LENGTH} characters`,
      {
        maxLength: DESCRIPTION_MAX_LENGTH,
        actualLength,
      }
    );
  }

  const plainText = descriptionPlainText(html);
  return { html, plainText, changed };
}

/**
 * Deterministic plain-text projection of a description (SPEC-V2 §6.9):
 * all tags stripped, HTML character entities decoded, and the same
 * `DESCRIPTION_MAX_LENGTH` code-point cap enforced without truncation.
 *
 * Returns a branded `PlainText` string that must NEVER be inserted into HTML.
 */
export function descriptionPlainText(html: string): PlainText {
  assertValidStringInput(html);
  if (html === '') {
    return '' as PlainText;
  }

  let output = '';

  try {
    const tree = fromHtml(html, { fragment: true });
    assertMaxDepth(tree, MAX_NESTING_DEPTH);

    let pendingSpace = false;
    let lastWasWhitespace = true;

    type StackItem =
      | { kind: 'node'; node: HastRootContent }
      | { kind: 'afterBlock' };

    const stack: StackItem[] = [];
    for (let i = tree.children.length - 1; i >= 0; i--) {
      stack.push({ kind: 'node', node: tree.children[i]! });
    }

    while (stack.length > 0) {
      const item = stack.pop()!;
      if (item.kind === 'afterBlock') {
        if (output.length > 0) {
          pendingSpace = true;
        }
        continue;
      }

      const { node } = item;
      if (node.type === 'text') {
        const text = node.value;
        if (text.length === 0) continue;
        if (
          pendingSpace &&
          output.length > 0 &&
          !lastWasWhitespace &&
          !isWhitespaceChar(text[0]!)
        ) {
          output += ' ';
        }
        pendingSpace = false;
        output += text;
        lastWasWhitespace = isWhitespaceChar(text[text.length - 1]!);
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

      if (node.tagName === 'template') {
        const templateChildren =
          node.content?.children && node.content.children.length > 0
            ? node.content.children
            : node.children;
        for (let i = templateChildren.length - 1; i >= 0; i--) {
          stack.push({ kind: 'node', node: templateChildren[i]! });
        }
        continue;
      }

      const isBlock = BLOCK_OR_BREAK_TAGS.has(node.tagName);
      if (isBlock && output.length > 0) {
        pendingSpace = true;
      }

      if (isBlock) {
        stack.push({ kind: 'afterBlock' });
      }
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ kind: 'node', node: node.children[i]! });
      }
    }
  } catch (error) {
    if (error instanceof RangeError) {
      throw tooComplexError();
    }
    throw error;
  }

  const actualLength = countCodePoints(output);
  if (actualLength > DESCRIPTION_MAX_LENGTH) {
    throw new InvalidDescriptionError(
      'MAX_LENGTH_EXCEEDED',
      `Description plain-text projection exceeds maximum length of ${DESCRIPTION_MAX_LENGTH} characters`,
      {
        maxLength: DESCRIPTION_MAX_LENGTH,
        actualLength,
      }
    );
  }

  return output as PlainText;
}
