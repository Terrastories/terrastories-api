/**
 * SPEC-V2 §6.9 safe description sanitiser and plain-text projection tests (#189).
 */
import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_LENGTH,
  InvalidDescriptionError,
  descriptionPlainText,
  sanitizeDescription,
  sanitizeDescriptionForMigration,
  validateDescriptionForWrite,
} from '../../src/shared/utils/safe-description.js';
import { ValidationError } from '../../src/shared/errors/index.js';
import {
  bundleWorkerModule,
  startWorkerRuntime,
} from '../helpers/worker-runtime.js';

describe('safe-description (SPEC-V2 §6.9)', () => {
  it('defines DESCRIPTION_MAX_LENGTH as 20_000', () => {
    expect(DESCRIPTION_MAX_LENGTH).toBe(20_000);
  });

  describe('allowlist and attribute stripping', () => {
    it('preserves all allowlisted tags and valid links with exact rel', () => {
      const input =
        '<p><strong>Bold</strong> <b>b</b> <em>em</em> <i>i</i><br>' +
        '<a href="https://example.com/path?a=1&amp;b=2">link</a></p>' +
        '<ul><li>One</li></ul><ol><li>Two</li></ol>';

      const result = sanitizeDescription(input);
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

      const result = sanitizeDescription(input);
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

    it('strips non-allowlisted container/formatting tags while keeping safe text', () => {
      const input =
        '<div class="wrap"><h1>Title</h1><span style="font-size:9px">Text</span> <u>under</u></div>';
      const result = sanitizeDescription(input);
      expect(result.changed).toBe(true);
      expect(result.html).toBe('TitleText under');
    });

    it('unwraps anchor elements that have no href attribute', () => {
      const result = sanitizeDescription(
        '<a name="top" target="_blank">Top</a>'
      );
      expect(result.changed).toBe(true);
      expect(result.html).toBe('Top');
    });
  });

  describe('scripts, styles, comments, embedded media, and OWASP XSS vectors', () => {
    it('removes scripts, styles, comments, and embedded media with their content', () => {
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
        const result = sanitizeDescription(input);
        expect(result.html).toBe(expected);
        expect(result.html).not.toContain('[removed]');
        expect(result.html).not.toContain('alert(1)');
      }
    });

    it('handles nested, unclosed, uppercase, and malformed tags safely', () => {
      expect(sanitizeDescription('<p><b>unclosed').html).toBe(
        '<p><b>unclosed</b></p>'
      );
      expect(sanitizeDescription('<<script>alert(1)</script>').html).toBe(
        '&lt;'
      );
      expect(
        sanitizeDescription('<script<script>>alert(1)</script>').html
      ).toBe('>alert(1)');
      expect(
        sanitizeDescription(
          '<STRONG><A HREF="https://example.com/" TARGET="_blank">Go</A></STRONG>'
        ).html
      ).toBe(
        '<strong><a href="https://example.com/" rel="noopener noreferrer nofollow">Go</a></strong>'
      );
      expect(
        sanitizeDescription(
          '<a/href="https://example.com/" onclick=alert(1)>Slash</a>'
        ).html
      ).toBe(
        '<a href="https://example.com/" rel="noopener noreferrer nofollow">Slash</a>'
      );
      expect(
        sanitizeDescription(
          '<a href="https://example.com/" title="a>b" onmouseover=alert(1)>Quote</a>'
        ).html
      ).toBe(
        '<a href="https://example.com/" rel="noopener noreferrer nofollow">Quote</a>'
      );
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
        expect(() => sanitizeDescription(payload)).toThrow(
          InvalidDescriptionError
        );
        expect(() => validateDescriptionForWrite(payload)).toThrow(
          InvalidDescriptionError
        );
      }
    });
  });

  describe('WHATWG URL href rules and runtime vs migration behavior', () => {
    it('allows http:, https:, and mailto: and preserves mailto query spaces percent-encoded', () => {
      const httpRes = sanitizeDescription(
        '<a href="  \thttps://exa\tmple.com/pa\nth \r\n">Site</a>'
      );
      expect(httpRes.html).toBe(
        '<a href="https://example.com/path" rel="noopener noreferrer nofollow">Site</a>'
      );

      const mailtoRes = sanitizeDescription(
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
        expect(() => sanitizeDescription(html)).toThrow(
          InvalidDescriptionError
        );
        expect(() => validateDescriptionForWrite(html)).toThrow(
          InvalidDescriptionError
        );
      }
    });

    it('drops non-conforming hrefs while keeping anchor text in migration mode and reports changes', () => {
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
        exceedsMaxLength: false,
      });
    });
  });

  describe('length cap and error content isolation', () => {
    it('accepts sanitised HTML up to 20,000 characters and rejects over-length without truncating', () => {
      const exact = 'a'.repeat(DESCRIPTION_MAX_LENGTH);
      const ok = validateDescriptionForWrite(exact);
      expect(ok.html).toBe(exact);
      expect(ok.plainText).toBe(exact);
      expect(ok.changed).toBe(false);

      // Over 20,000 raw input that strips down to <= 20,000 sanitised HTML passes
      const strippedUnderCap =
        '<script>' +
        'x'.repeat(500) +
        '</script>' +
        'b'.repeat(DESCRIPTION_MAX_LENGTH);
      expect(validateDescriptionForWrite(strippedUnderCap).html.length).toBe(
        DESCRIPTION_MAX_LENGTH
      );

      // Over 20,000 sanitised HTML (even 20,001 or <p> + 20,000 + </p>) rejects
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

    it('never leaks description content or offending hrefs in thrown errors', () => {
      const secretText = 'SACRED_COMMUNITY_SECRET_TEXT_12345';
      const secretHref = 'javascript:secretFn("PRIVATE_TOKEN_98765")';

      try {
        validateDescriptionForWrite(
          `<p>${secretText} <a href="${secretHref}">x</a></p>`
        );
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(error).toBeInstanceOf(InvalidDescriptionError);
        const serialized = JSON.stringify({
          message: (error as Error).message,
          context: (error as InvalidDescriptionError).context,
          reason: (error as InvalidDescriptionError).reason,
        });
        expect(serialized).not.toContain(secretText);
        expect(serialized).not.toContain('javascript:');
        expect(serialized).not.toContain('PRIVATE_TOKEN_98765');
      }

      const longSecret = 'SENSITIVE_STORY_BODY_'.repeat(1000);
      try {
        validateDescriptionForWrite(longSecret);
        expect.fail('Expected InvalidDescriptionError');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidDescriptionError);
        const serialized = JSON.stringify({
          message: (error as Error).message,
          context: (error as InvalidDescriptionError).context,
          reason: (error as InvalidDescriptionError).reason,
        });
        expect(serialized).not.toContain('SENSITIVE_STORY_BODY');
      }
    });
  });

  describe('plain-text projection, multilingual preservation, and idempotence', () => {
    it('projects deterministic plain text with tags stripped and entities decoded', () => {
      const html =
        '<p>Hello <strong>wor</strong>ld &amp; &lt;friends&gt; &quot;hi&quot; &#39;ok&#39; &mdash; end</p>' +
        '<p>Line 1<br>Line 2</p>' +
        '<ul><li>First</li><li>Second</li></ul>';

      const first = descriptionPlainText(html);
      const second = descriptionPlainText(html);
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
      const sanitized = sanitizeDescription(multilingual);
      expect(sanitized.changed).toBe(false);
      expect(sanitized.html).toBe(multilingual);

      const expectedText =
        'São Paulo, Brasília, naïve, résumé, Guaraní g̃ — Αθήνα (ΟΔΟΣ, ς/σ) — 日本語テスト・中文測試・한국어';
      expect(descriptionPlainText(sanitized.html)).toBe(expectedText);

      // UTF-8 byte equality
      expect(
        Buffer.from(descriptionPlainText(sanitized.html), 'utf8').equals(
          Buffer.from(expectedText, 'utf8')
        )
      ).toBe(true);
    });

    it('is idempotent under repeated sanitisation', () => {
      const inputs = [
        '',
        '<p>Simple <b>text</b></p>',
        '<div class="x"><p onclick="bad()">Hello <a href="https://example.com" target="_blank">world</a></p></div>',
        '<p>1 < 2 & 3 > 1</p>',
        '<p><a href="mailto:a@b.com?subject=hello world">mail</a></p>',
        '<p>São Paulo — Αθήνα — 日本語</p>',
      ];

      for (const input of inputs) {
        const once = sanitizeDescription(input);
        const twice = sanitizeDescription(once.html);
        expect(twice.html).toBe(once.html);
        expect(twice.changed).toBe(false);
      }

      const migrationInputs = [
        ...inputs,
        '<p><a href="javascript:alert(1)">bad</a> and <a href="/rel">rel</a></p>',
      ];
      for (const input of migrationInputs) {
        const once = sanitizeDescriptionForMigration(input);
        const twice = sanitizeDescriptionForMigration(once.html);
        expect(twice.html).toBe(once.html);
        expect(twice.changed).toBe(false);
        expect(twice.droppedHrefs).toBe(0);
      }
    });
  });

  describe('Cloudflare Workers (workerd) compatibility', () => {
    it('bundles with zero Node built-ins and executes identically in workerd', async () => {
      const script = await bundleWorkerModule(`
        import {
          DESCRIPTION_MAX_LENGTH,
          descriptionPlainText,
          sanitizeDescription,
          sanitizeDescriptionForMigration,
          validateDescriptionForWrite,
        } from './src/shared/utils/safe-description.js';

        export default {
          async fetch(request) {
            const payload = await request.json();
            const runtime = validateDescriptionForWrite(payload.valid);
            const migration = sanitizeDescriptionForMigration(payload.badHref);
            let rejected = false;
            try {
              sanitizeDescription(payload.badHref);
            } catch {
              rejected = true;
            }
            return Response.json({
              maxLength: DESCRIPTION_MAX_LENGTH,
              runtimeHtml: runtime.html,
              runtimePlain: runtime.plainText,
              migrationHtml: migration.html,
              droppedHrefs: migration.droppedHrefs,
              rejected,
              plain: descriptionPlainText('<p>Café &amp; 日本語</p>'),
            });
          },
        };
      `);

      const mf = startWorkerRuntime(script);
      try {
        const res = await mf.dispatchFetch('https://worker.test/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            valid:
              '<p class="x"><a href="https://example.com" target="_blank">Link</a><script>evil()</script></p>',
            badHref: '<p><a href="&#106;avascript:alert(1)">Click</a></p>',
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          maxLength: 20_000,
          runtimeHtml:
            '<p><a href="https://example.com/" rel="noopener noreferrer nofollow">Link</a></p>',
          runtimePlain: 'Link',
          migrationHtml: '<p>Click</p>',
          droppedHrefs: 1,
          rejected: true,
          plain: 'Café & 日本語',
        });
      } finally {
        await mf.dispose();
      }
    });
  });
});
