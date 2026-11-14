/**
 * SPEC-V2 §6.9 safe description sanitiser and plain-text projection tests (#189).
 */
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as safeDescriptionModule from '../../src/shared/utils/safe-description.js';
import {
  DESCRIPTION_MAX_LENGTH,
  DESCRIPTION_MAX_RAW_LENGTH,
  InvalidDescriptionError,
  MAX_NESTING_DEPTH,
  type PlainText,
  descriptionPlainText,
  sanitizeDescriptionForMigration,
  validateDescriptionForWrite,
} from '../../src/shared/utils/safe-description.js';
import { ValidationError } from '../../src/shared/errors/index.js';
import {
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

function parseWranglerConfig(): {
  compatibility_date: string;
  compatibility_flags?: string[];
} {
  const raw = readFileSync('wrangler.jsonc', 'utf8');
  const withoutComments = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const withoutTrailingCommas = withoutComments.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas) as {
    compatibility_date: string;
    compatibility_flags?: string[];
  };
}

function assertErrorNeverLeaks(
  error: unknown,
  forbiddenTokens: string[]
): void {
  expect(error).toBeInstanceOf(ValidationError);
  expect(error).toBeInstanceOf(InvalidDescriptionError);
  const err = error as InvalidDescriptionError & {
    toJSON?: () => unknown;
  };
  const ownProps: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(err)) {
    ownProps[key] = (err as unknown as Record<string, unknown>)[key];
  }
  const serialized = JSON.stringify({
    message: err.message,
    reason: err.reason,
    context: err.context,
    stack: err.stack,
    cause: err.cause,
    ownProps,
    toJSON: typeof err.toJSON === 'function' ? err.toJSON() : undefined,
  });
  for (const token of forbiddenTokens) {
    expect(serialized).not.toContain(token);
  }
}

describe('safe-description (SPEC-V2 §6.9)', () => {
  it('defines DESCRIPTION_MAX_LENGTH as 20_000 and exposes validateDescriptionForWrite as sole runtime write entry point', () => {
    expect(DESCRIPTION_MAX_LENGTH).toBe(20_000);
    expect(DESCRIPTION_MAX_RAW_LENGTH).toBe(80_000);
    expect(MAX_NESTING_DEPTH).toBe(128);
    expect(
      (safeDescriptionModule as Record<string, unknown>).sanitizeDescription
    ).toBeUndefined();
  });

  describe('allowlist and attribute stripping', () => {
    it('preserves all allowlisted tags and valid links with exact rel', () => {
      const input =
        '<p><strong>Bold</strong> <b>b</b> <em>em</em> <i>i</i><br>' +
        '<a href="https://example.com/path?a=1&amp;b=2">link</a></p>' +
        '<ul><li>One</li></ul><ol><li>Two</li></ol>';

      const result = validateDescriptionForWrite(input);
      expect(result.changed).toBe(true);
      expect(result.html).toBe(
        '<p><strong>Bold</strong> <b>b</b> <em>em</em> <i>i</i><br>' +
          '<a href="https://example.com/path?a=1&amp;b=2" rel="noopener noreferrer nofollow">link</a></p>' +
          '<ul><li>One</li></ul><ol><li>Two</li></ol>'
      );
    });

    it('removes every disallowed attribute including target, style, class, and event handlers', () => {
      const input =
        '<p class="lead" style="color:red" id="p1" onclick="evil()">' +
        '<strong data-x="1" onmouseover="evil()">Hello</strong> ' +
        '<a href="https://example.com/" target="_blank" style="x:y" class="btn" rel="opener" onclick="evil()">visit</a>' +
        '</p>';

      const result = validateDescriptionForWrite(input);
      expect(result.changed).toBe(true);
      expect(result.html).toBe(
        '<p><strong>Hello</strong> ' +
          '<a href="https://example.com/" rel="noopener noreferrer nofollow">visit</a></p>'
      );
      expect(result.html).not.toContain('target');
      expect(result.html).not.toContain('style');
      expect(result.html).not.toContain('class');
      expect(result.html).not.toContain('onclick');
      expect(result.html).not.toContain('onmouseover');
      expect(result.html).not.toContain('data-x');
      expect(result.html).not.toContain('id=');
    });

    it('promotes non-allowlisted block elements to paragraphs so adjacent words never glue together', () => {
      const input =
        '<div class="wrap"><h1>Title</h1><span>Text</span> <u>under</u></div>';
      const result = validateDescriptionForWrite(input);
      expect(result.changed).toBe(true);
      expect(result.html).toBe('<p>Title</p>Text under');
      expect(result.plainText).toBe('Title Text under');

      const allBlocks =
        '<div>d</div><h1>h1</h1><h2>h2</h2><h3>h3</h3><h4>h4</h4><h5>h5</h5><h6>h6</h6>' +
        '<blockquote>bq</blockquote><pre>pre</pre><section>sec</section><article>art</article>' +
        '<header>hdr</header><footer>ftr</footer><table><thead><tr><th>th</th></tr></thead>' +
        '<tbody><tr><td>td</td></tr></tbody></table><dl><dt>dt</dt><dd>dd</dd></dl>' +
        '<figure><figcaption>fig</figcaption></figure><address>addr</address>' +
        '<details><summary>sum</summary>det</details>';
      const blocksResult = validateDescriptionForWrite(allBlocks);
      expect(blocksResult.plainText).toBe(
        'd h1 h2 h3 h4 h5 h6 bq pre sec art hdr ftr th td dt dd fig addr sum det'
      );

      // Container block with inline prefix/suffix does not glue words across boundaries.
      const mixedContainer = validateDescriptionForWrite(
        'Before<div>One<p>Two</p>Three</div>After'
      );
      expect(mixedContainer.html).toBe('Before One<p>Two</p>Three After');
      expect(mixedContainer.plainText).toBe('Before One Two Three After');
    });

    it('unwraps anchor elements that have no href attribute', () => {
      const result = validateDescriptionForWrite(
        '<a name="top" target="_blank">Top</a>'
      );
      expect(result.changed).toBe(true);
      expect(result.html).toBe('Top');
    });
  });

  describe('scripts, styles, comments, embedded media, and OWASP XSS vectors', () => {
    it('removes scripts, styles, comments, and embedded media with their content while unwrapping text-bearing tags', () => {
      const vectors: Array<[string, string]> = [
        ['<script>alert(1)</script>after', 'after'],
        ['<SCRIPT type="text/javascript">alert(1)</SCRIPT>', ''],
        [
          '<style>body{background:url(javascript:alert(1))}</style>text',
          'text',
        ],
        ['<!-- secret comment -->visible', 'visible'],
        ['<!--<script>-->visible', 'visible'],
        ['<svg onload="alert(1)"><script>alert(1)</script>bad</svg>ok', 'ok'],
        [
          '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
          '',
        ],
        ['<iframe src="https://evil.test">fallback</iframe>ok', 'ok'],
        ['<img src="x" onerror="alert(1)">ok', 'ok'],
        ['<video src="x"><source src="y">fallback</video>ok', 'ok'],
        ['<audio src="x">fallback</audio>ok', 'ok'],
        ['<object data="x">fallback</object>ok', 'ok'],
        ['<embed src="x">ok', 'ok'],
        ['<noscript><img src=x onerror=alert(1)></noscript>ok', 'ok'],
        ['<template><script>alert(1)</script></template>ok', 'ok'],
      ];

      for (const [input, expected] of vectors) {
        const result = validateDescriptionForWrite(input);
        expect(result.html).toBe(expected);
        expect(result.html).not.toContain('[removed]');
        expect(result.html).not.toContain('alert(1)');
      }
    });

    it('unwraps textarea, title, xmp, noembed, noframes, noscript, template, and plaintext safely as text', () => {
      const cases: Array<[string, string, string]> = [
        [
          '<textarea>Story <b>notes</b></textarea>',
          'Story &lt;b>notes&lt;/b>',
          'Story <b>notes</b>',
        ],
        ['<title>Page &amp; Title</title>', 'Page &amp; Title', 'Page & Title'],
        ['<xmp>1 < 2</xmp>', '1 &lt; 2', '1 < 2'],
        ['<noembed>Legacy text</noembed>', 'Legacy text', 'Legacy text'],
        ['<noframes>Frame text</noframes>', 'Frame text', 'Frame text'],
        [
          '<noscript>Enable JS for map</noscript>',
          'Enable JS for map',
          'Enable JS for map',
        ],
        [
          '<template>Template <b>body</b></template>',
          'Template <b>body</b>',
          'Template body',
        ],
        [
          '<plaintext>Raw <script>alert(1)</script> text',
          'Raw &lt;script>alert(1)&lt;/script> text',
          'Raw <script>alert(1)</script> text',
        ],
      ];

      for (const [input, expectedHtml, expectedPlain] of cases) {
        const runtime = validateDescriptionForWrite(input);
        expect(runtime.html).toBe(expectedHtml);
        expect(runtime.plainText).toBe(expectedPlain);

        const migration = sanitizeDescriptionForMigration(input);
        expect(migration.html).toBe(expectedHtml);
        expect(migration.removedNodes).toBe(0);
      }
    });

    it('handles nested, unclosed, uppercase, and malformed tags safely', () => {
      expect(validateDescriptionForWrite('<p><b>unclosed').html).toBe(
        '<p><b>unclosed</b></p>'
      );
      expect(
        validateDescriptionForWrite('<<script>alert(1)</script>').html
      ).toBe('&lt;');
      expect(
        validateDescriptionForWrite('<script<script>>alert(1)</script>').html
      ).toBe('>alert(1)');
      expect(
        validateDescriptionForWrite(
          '<STRONG><A HREF="https://example.com/" TARGET="_blank">Go</A></STRONG>'
        ).html
      ).toBe(
        '<strong><a href="https://example.com/" rel="noopener noreferrer nofollow">Go</a></strong>'
      );
      expect(
        validateDescriptionForWrite(
          '<a/href="https://example.com/" onclick=alert(1)>Slash</a>'
        ).html
      ).toBe(
        '<a href="https://example.com/" rel="noopener noreferrer nofollow">Slash</a>'
      );
      expect(
        validateDescriptionForWrite(
          '<a href="https://example.com/" title="a>b" onmouseover=alert(1)>Quote</a>'
        ).html
      ).toBe(
        '<a href="https://example.com/" rel="noopener noreferrer nofollow">Quote</a>'
      );
    });

    it('percent-encodes and attribute-escapes href containing "><script>', () => {
      const input = `<a href='https://example.com/?q="><script>alert(1)</script>'>x</a>`;
      const result = validateDescriptionForWrite(input);
      expect(result.html).toBe(
        '<a href="https://example.com/?q=%22%3E%3Cscript%3Ealert(1)%3C/script%3E" rel="noopener noreferrer nofollow">x</a>'
      );
      expect(result.html).not.toContain('<script>');
      expect(validateDescriptionForWrite(result.html).changed).toBe(false);
    });

    it('rejects dangerous schemes and entity/whitespace-obfuscated schemes at runtime', () => {
      const dangerousHrefs = [
        'javascript:alert(1)',
        'JAVASCRIPT:alert(1)',
        '&#106;avascript:alert(1)',
        '&#x6a;avascript:alert(1)',
        'java\tscript:alert(1)',
        'java\nscript:alert(1)',
        'java\rscript:alert(1)',
        'java&#x09;script:alert(1)',
        'javascript&colon;alert(1)',
        '&#x26;&#x23;106;avascript:alert(1)',
        '  \t\njavascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'ftp://example.com/file',
        'tel:+1234567890',
        'mailto:',
        '',
      ];

      for (const href of dangerousHrefs) {
        const payload = `<p><a href="${href}">click</a></p>`;
        expect(() => validateDescriptionForWrite(payload)).toThrow(
          InvalidDescriptionError
        );
      }
    });
  });

  describe('WHATWG URL href rules and runtime vs migration behavior', () => {
    it('allows http:, https:, and mailto: and preserves mailto query spaces percent-encoded', () => {
      const httpRes = validateDescriptionForWrite(
        '<a href="  \thttps://exa\tmple.com/pa\nth \r\n">Site</a>'
      );
      expect(httpRes.html).toBe(
        '<a href="https://example.com/path" rel="noopener noreferrer nofollow">Site</a>'
      );

      const mailtoRes = validateDescriptionForWrite(
        '<a href="mailto:community@example.org?subject=hello world&amp;body=two words">Email</a>'
      );
      expect(mailtoRes.html).toBe(
        '<a href="mailto:community@example.org?subject=hello%20world&amp;body=two%20words" rel="noopener noreferrer nofollow">Email</a>'
      );
    });

    it('rejects relative, protocol-relative (//), and fragment-only (#) hrefs at runtime', () => {
      for (const href of [
        '/stories/1',
        'stories/1',
        '?search=map',
        '//evil.example/path',
        '#section-1',
      ]) {
        const html = `<p>See <a href="${href}">here</a>.</p>`;
        expect(() => validateDescriptionForWrite(html)).toThrow(
          InvalidDescriptionError
        );
      }
    });

    it('drops non-conforming hrefs while keeping anchor text in migration mode and reports removedNodes', () => {
      const migrationCases = [
        '<p>See <a href="/stories/1">this story</a>.</p>',
        '<p>See <a href="//evil.example/x">external</a>.</p>',
        '<p>See <a href="#top">top</a>.</p>',
        '<p>See <a href="&#106;avascript:alert(1)"><b>bold</b> link</a>.</p>',
        '<p>See <a href="java\tscript:alert(1)">tabbed</a>.</p>',
        '<p>See <a href="data:text/html,evil">data</a>.</p>',
        '<p>See <a href="vbscript:msgbox(1)">vb</a>.</p>',
      ];

      for (const input of migrationCases) {
        const res = sanitizeDescriptionForMigration(input);
        expect(res.changed).toBe(true);
        expect(res.droppedHrefs).toBe(1);
        expect(res.removedNodes).toBe(0);
        expect(res.html).not.toContain('href');
        expect(res.html).not.toContain('<a');
        expect(res.html).not.toContain('rel=');
        expect(res.html).not.toContain('target=');
      }

      expect(
        sanitizeDescriptionForMigration(
          '<p>See <a href="/stories/1">this story</a> and <a href="https://example.org/">valid</a>.</p>'
        )
      ).toEqual({
        html: '<p>See this story and <a href="https://example.org/" rel="noopener noreferrer nofollow">valid</a>.</p>',
        changed: true,
        droppedHrefs: 1,
        removedNodes: 0,
        exceedsMaxLength: false,
      });

      // Stripped text-bearing nodes are counted in removedNodes; empty media is 0.
      expect(
        sanitizeDescriptionForMigration(
          '<p>Keep</p><iframe src="https://x">fallback</iframe><video><source src="y">caption</video><img src="z">'
        )
      ).toEqual({
        html: '<p>Keep</p>',
        changed: true,
        droppedHrefs: 0,
        removedNodes: 2,
        exceedsMaxLength: false,
      });
    });
  });

  describe('input validation, DoS bounds, length cap (code points), and error isolation', () => {
    it('rejects non-string inputs with INVALID_TYPE and lone surrogates with INVALID_UNICODE', () => {
      for (const invalid of [null, undefined, 123, {}, []]) {
        for (const fn of [
          validateDescriptionForWrite,
          sanitizeDescriptionForMigration,
          descriptionPlainText,
        ]) {
          try {
            fn(invalid as unknown as string);
            expect.fail('Expected InvalidDescriptionError');
          } catch (error) {
            expect(error).toBeInstanceOf(InvalidDescriptionError);
            expect((error as InvalidDescriptionError).reason).toBe(
              'INVALID_TYPE'
            );
          }
        }
      }

      for (const malformed of ['\uD800', 'abc\uDC00def', '<p>\uD83D</p>']) {
        for (const fn of [
          validateDescriptionForWrite,
          sanitizeDescriptionForMigration,
          descriptionPlainText,
        ]) {
          try {
            fn(malformed);
            expect.fail('Expected InvalidDescriptionError');
          } catch (error) {
            expect(error).toBeInstanceOf(InvalidDescriptionError);
            expect((error as InvalidDescriptionError).reason).toBe(
              'INVALID_UNICODE'
            );
          }
        }
      }
    });

    it('rejects oversized raw inputs (INPUT_TOO_LARGE) and deep nesting (TOO_COMPLEX) as typed errors, never RangeError', () => {
      const oversized = 'a'.repeat(DESCRIPTION_MAX_RAW_LENGTH + 1);
      const deep200k = '<b>'.repeat(200_000);
      const deep25k = '<b>'.repeat(25_000);
      const deep200 = '<b>'.repeat(200);
      const deep129 = `${'<b>'.repeat(129)}ok${'</b>'.repeat(129)}`;
      const deep128 = `${'<b>'.repeat(128)}ok${'</b>'.repeat(128)}`;

      expect(validateDescriptionForWrite(deep128).plainText).toBe('ok');

      for (const fn of [
        validateDescriptionForWrite,
        sanitizeDescriptionForMigration,
        descriptionPlainText,
      ]) {
        for (const [payload, expectedReason] of [
          [oversized, 'INPUT_TOO_LARGE'],
          [deep200k, 'INPUT_TOO_LARGE'],
          [deep25k, 'TOO_COMPLEX'],
          [deep200, 'TOO_COMPLEX'],
          [deep129, 'TOO_COMPLEX'],
        ] as const) {
          try {
            fn(payload);
            expect.fail(`Expected InvalidDescriptionError (${expectedReason})`);
          } catch (error) {
            expect(error).not.toBeInstanceOf(RangeError);
            expect(error).toBeInstanceOf(InvalidDescriptionError);
            expect((error as InvalidDescriptionError).reason).toBe(
              expectedReason
            );
          }
        }
      }
    });

    it('accepts sanitised HTML up to 20,000 Unicode code points (including astral chars) and rejects over-length without truncating', () => {
      const exact = 'a'.repeat(DESCRIPTION_MAX_LENGTH);
      const ok = validateDescriptionForWrite(exact);
      expect(ok.html).toBe(exact);
      expect(ok.plainText).toBe(exact);
      expect(ok.changed).toBe(false);

      // Exactly 20,000 astral characters (40,000 UTF-16 code units, 20,000 code points) passes
      const astralExact = '😀'.repeat(DESCRIPTION_MAX_LENGTH);
      expect(astralExact.length).toBe(40_000);
      const astralOk = validateDescriptionForWrite(astralExact);
      expect(astralOk.html).toBe(astralExact);
      expect(astralOk.plainText).toBe(astralExact);
      expect(descriptionPlainText(astralExact)).toBe(astralExact);

      // 20,001 astral characters rejects with code-point actualLength
      const astralTooLong = '😀'.repeat(DESCRIPTION_MAX_LENGTH + 1);
      try {
        validateDescriptionForWrite(astralTooLong);
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidDescriptionError);
        const err = error as InvalidDescriptionError;
        expect(err.reason).toBe('MAX_LENGTH_EXCEEDED');
        expect(err.context).toEqual({
          maxLength: DESCRIPTION_MAX_LENGTH,
          actualLength: DESCRIPTION_MAX_LENGTH + 1,
        });
      }

      // Over 20,000 raw input (<= 80,000) that strips down to <= 20,000 sanitised HTML passes
      const strippedUnderCap =
        '<script>' +
        'x'.repeat(500) +
        '</script>' +
        'b'.repeat(DESCRIPTION_MAX_LENGTH);
      expect(validateDescriptionForWrite(strippedUnderCap).html.length).toBe(
        DESCRIPTION_MAX_LENGTH
      );

      // Link-heavy input near the cap: raw < 20,000, server-added rel + / pushes sanitised > 20,000
      const linkUnit = '<a href="https://example.com">x</a>';
      const sanitizedUnit =
        '<a href="https://example.com/" rel="noopener noreferrer nofollow">x</a>';
      const maxLinksFitting = Math.floor(
        DESCRIPTION_MAX_LENGTH / sanitizedUnit.length
      );
      const fittingLinks = linkUnit.repeat(maxLinksFitting);
      const fittingRes = validateDescriptionForWrite(fittingLinks);
      expect(fittingRes.html.length).toBeLessThanOrEqual(
        DESCRIPTION_MAX_LENGTH
      );

      const overflowLinks = linkUnit.repeat(maxLinksFitting + 1);
      expect(overflowLinks.length).toBeLessThan(DESCRIPTION_MAX_LENGTH);
      expect(() => validateDescriptionForWrite(overflowLinks)).toThrow(
        InvalidDescriptionError
      );

      // Over 20,000 sanitised HTML rejects
      const tooLong = 'c'.repeat(DESCRIPTION_MAX_LENGTH + 1);
      expect(() => validateDescriptionForWrite(tooLong)).toThrow(
        InvalidDescriptionError
      );
      const wrappedTooLong = `<p>${'c'.repeat(DESCRIPTION_MAX_LENGTH)}</p>`;
      expect(() => validateDescriptionForWrite(wrappedTooLong)).toThrow(
        InvalidDescriptionError
      );

      // Plain-text projection enforces the same cap without silent truncation
      expect(() =>
        descriptionPlainText('d'.repeat(DESCRIPTION_MAX_LENGTH + 1))
      ).toThrow(InvalidDescriptionError);
    });

    it('never leaks description content or offending hrefs in thrown errors (message, reason, context, stack, cause, ownProps, toJSON)', () => {
      const secretText = 'SACRED_COMMUNITY_SECRET_TEXT_12345';
      const secretHref = 'javascript:secretFn("PRIVATE_TOKEN_98765")';

      try {
        validateDescriptionForWrite(
          `<p>${secretText} <a href="${secretHref}">x</a></p>`
        );
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        assertErrorNeverLeaks(error, [
          secretText,
          'javascript:',
          'PRIVATE_TOKEN_98765',
        ]);
      }

      const longSecret = 'SENSITIVE_STORY_BODY_'.repeat(1000);
      try {
        validateDescriptionForWrite(longSecret);
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        assertErrorNeverLeaks(error, ['SENSITIVE_STORY_BODY']);
      }

      const oversizedSecret = 'OVERSIZED_SECRET_'.repeat(5000);
      try {
        validateDescriptionForWrite(oversizedSecret);
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        assertErrorNeverLeaks(error, ['OVERSIZED_SECRET']);
      }

      const complexSecret = `${'<b>'.repeat(130)}COMPLEX_SECRET_VALUE${'</b>'.repeat(130)}`;
      try {
        validateDescriptionForWrite(complexSecret);
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        assertErrorNeverLeaks(error, ['COMPLEX_SECRET_VALUE']);
      }

      const unicodeSecret = 'UNICODE_SECRET_\uD800';
      try {
        validateDescriptionForWrite(unicodeSecret);
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        assertErrorNeverLeaks(error, ['UNICODE_SECRET']);
      }
    });
  });

  describe('plain-text projection, multilingual preservation, and idempotence', () => {
    it('projects deterministic branded PlainText with tags stripped and entities decoded', () => {
      const html =
        '<p>Hello <strong>wor</strong>ld &amp; &lt;friends&gt; &quot;hi&quot; &#39;ok&#39; &mdash; end</p>' +
        '<p>Line 1<br>Line 2</p>' +
        '<ul><li>First</li><li>Second</li></ul>';

      const first: PlainText = descriptionPlainText(html);
      const second: PlainText = descriptionPlainText(html);
      expect(first).toBe(second);
      expect(first).toBe(
        'Hello world & <friends> "hi" \'ok\' — end Line 1 Line 2 First Second'
      );

      // Stripped tags never leak into plain-text projection
      expect(
        descriptionPlainText('<script>evil()</script><p>Safe &amp; sound</p>')
      ).toBe('Safe & sound');
    });

    it('preserves multilingual text (diacritics, Greek, CJK) byte-exact', () => {
      const multilingual =
        '<p>São Paulo, Brasília, naïve, résumé, Guaraní g̃ — Αθήνα (ΟΔΟΣ, ς/σ) — 日本語テスト・中文測試・한국어</p>';
      const sanitized = validateDescriptionForWrite(multilingual);
      expect(sanitized.changed).toBe(false);
      expect(sanitized.html).toBe(multilingual);

      const expectedText =
        'São Paulo, Brasília, naïve, résumé, Guaraní g̃ — Αθήνα (ΟΔΟΣ, ς/σ) — 日本語テスト・中文測試・한국어';
      expect(sanitized.plainText).toBe(expectedText);
      expect(descriptionPlainText(sanitized.html)).toBe(expectedText);

      // UTF-8 byte equality
      expect(
        Buffer.from(descriptionPlainText(sanitized.html), 'utf8').equals(
          Buffer.from(expectedText, 'utf8')
        )
      ).toBe(true);
    });

    it('is idempotent under scope-boundary repros and mixed generated inputs', () => {
      const scopeBoundaryRepros = [
        '<p>a<button><p>b',
        '<ul><li>a<button><li>b',
        '<a href="https://x">1<table><td><a href="https://y">2',
      ];

      const simpleInputs = [
        '',
        '<p>Simple <b>text</b></p>',
        '<div class="x"><p onclick="bad()">Hello <a href="https://example.com" target="_blank">world</a></p></div>',
        '<p>1 < 2 & 3 > 1</p>',
        '<p><a href="mailto:a@b.com?subject=hello world">mail</a></p>',
        '<p>São Paulo — Αθήνα — 日本語 😀</p>',
      ];

      // Deterministic generated table of mixed HTML fragments combining
      // scope boundaries, blocks, RCDATA/rawtext tags, links, and formatting.
      const fragments = [
        '<p>alpha</p>',
        '<div>beta</div>',
        '<h1>heading</h1>',
        '<button>btn</button>',
        '<marquee><p>marq</p></marquee>',
        '<table><tr><td>cell</td></tr></table>',
        '<textarea>raw <b>t</b></textarea>',
        '<template><p>tpl</p><script>x()</script></template>',
        '<noscript>ns</noscript>',
        '<a href="https://example.com/p?a=1&amp;b=2">link</a>',
        '<ul><li>one<button><li>two</li></ul>',
        'text &amp; &lt;tag&gt; 😀',
      ];
      const generatedInputs: string[] = [];
      for (let i = 0; i < fragments.length; i++) {
        for (let j = 0; j < fragments.length; j++) {
          if ((i + j) % 3 === 0) {
            generatedInputs.push(`${fragments[i]}${fragments[j]}`);
          }
        }
      }

      for (const input of [
        ...simpleInputs,
        ...scopeBoundaryRepros,
        ...generatedInputs,
      ]) {
        const once = validateDescriptionForWrite(input);
        const twice = validateDescriptionForWrite(once.html);
        expect(twice.html).toBe(once.html);
        expect(twice.plainText).toBe(once.plainText);
        expect(twice.changed).toBe(false);
      }

      const migrationInputs = [
        ...simpleInputs,
        ...scopeBoundaryRepros,
        ...generatedInputs,
        '<p><a href="javascript:alert(1)">bad</a> and <a href="/rel">rel</a></p>',
        '<plaintext>tail <b>text</b>',
      ];
      for (const input of migrationInputs) {
        const once = sanitizeDescriptionForMigration(input);
        const twice = sanitizeDescriptionForMigration(once.html);
        expect(twice.html).toBe(once.html);
        expect(twice.changed).toBe(false);
        expect(twice.droppedHrefs).toBe(0);
        expect(twice.removedNodes).toBe(0);
      }
    });
  });

  describe('Cloudflare Workers (workerd) compatibility', () => {
    it('bundles with zero node: imports in esbuild metafile and executes identically in workerd under wrangler.jsonc settings', async () => {
      const esbuildResult = await build({
        entryPoints: ['src/shared/utils/safe-description.ts'],
        bundle: true,
        write: false,
        platform: 'browser',
        format: 'esm',
        metafile: true,
      });

      const metafile = esbuildResult.metafile!;
      const outputImports = Object.values(metafile.outputs).flatMap((output) =>
        output.imports.map((imp) => imp.path)
      );
      expect(outputImports).toEqual([]);

      const inputImports = Object.values(metafile.inputs).flatMap((input) =>
        input.imports.map((imp) => imp.path)
      );
      expect(inputImports.filter((p) => p.startsWith('node:'))).toEqual([]);
      const inputFiles = Object.keys(metafile.inputs);
      expect(inputFiles.some((f) => f.includes('minpath.browser.js'))).toBe(
        true
      );

      const wrangler = parseWranglerConfig();
      expect(wrangler.compatibility_date >= '2022-10-31').toBe(true);
      const compatFlags = wrangler.compatibility_flags ?? [];
      expect(compatFlags).not.toContain('url_original');
      expect(compatFlags).not.toContain('nodejs_compat');

      // wrangler.jsonc pins 2026-11-12 while miniflare@4.20260426.0 embeds
      // workerd supporting up to 2026-05-03; pass wrangler flags verbatim and
      // clamp date only when newer than the local workerd binary ceiling.
      const maxLocalWorkerdDate = '2026-05-03';
      const runtimeCompatDate =
        wrangler.compatibility_date > maxLocalWorkerdDate
          ? maxLocalWorkerdDate
          : wrangler.compatibility_date;

      const script = await bundleWorkerModule(`
        import {
          DESCRIPTION_MAX_LENGTH,
          descriptionPlainText,
          sanitizeDescriptionForMigration,
          validateDescriptionForWrite,
        } from './src/shared/utils/safe-description.js';

        export default {
          async fetch(request) {
            const payload = await request.json();
            const runtime = validateDescriptionForWrite(payload.valid);
            const urlNorm = validateDescriptionForWrite(payload.urlNorm);
            const migration = sanitizeDescriptionForMigration(payload.badHref);
            let rejected = false;
            try {
              validateDescriptionForWrite(payload.badHref);
            } catch {
              rejected = true;
            }
            return Response.json({
              maxLength: DESCRIPTION_MAX_LENGTH,
              runtimeHtml: runtime.html,
              runtimePlain: runtime.plainText,
              urlNormHtml: urlNorm.html,
              migrationHtml: migration.html,
              droppedHrefs: migration.droppedHrefs,
              removedNodes: migration.removedNodes,
              rejected,
              plain: descriptionPlainText('<p>Café &amp; 日本語</p>'),
            });
          },
        };
      `);

      const mf = startWorkerRuntime(
        script,
        { ENVIRONMENT: 'test' },
        {
          compatibilityDate: runtimeCompatDate,
          compatibilityFlags: compatFlags,
        }
      );
      try {
        const res = await mf.dispatchFetch('https://worker.test/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            valid:
              '<p class="x"><a href="https://example.com" target="_blank">Link</a><script>evil()</script></p>',
            urlNorm: '<a href="  \thttps://exa\tmple.com/pa\nth \r\n">Site</a>',
            badHref: '<p><a href="&#106;avascript:alert(1)">Click</a></p>',
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          maxLength: 20_000,
          runtimeHtml:
            '<p><a href="https://example.com/" rel="noopener noreferrer nofollow">Link</a></p>',
          runtimePlain: 'Link',
          urlNormHtml:
            '<a href="https://example.com/path" rel="noopener noreferrer nofollow">Site</a>',
          migrationHtml: '<p>Click</p>',
          droppedHrefs: 1,
          removedNodes: 0,
          rejected: true,
          plain: 'Café & 日本語',
        });
      } finally {
        await mf.dispose();
      }
    });
  });
});
