import { describe, it, expect } from 'vitest';
import {
  V2RuntimeConfigError,
  validateNodeV2Runtime,
  validateV2RuntimeCore,
  validateWorkerV2Runtime,
  v2RuntimeModeNotice,
} from '../../src/config/v2-runtime.js';

/** A valid production origin for the happy paths. */
const okOrigin = 'https://api.terrastories.org';

/** A valid prelogin HMAC key for production-like calls (not a literal credential). */
const okSecret = 'prelogin-hsm-material-9f8e7d6c5b4a3f2';

/**
 * A valid installation bootstrap secret for production-like calls (not a
 * literal credential): at least the 24-character minimum, no placeholder.
 */
const okBootstrapSecret = 'bootstrap-install-secret-0123456789abcdef';

const refusal = (fn: () => unknown): V2RuntimeConfigError => {
  try {
    fn();
  } catch (error) {
    if (error instanceof V2RuntimeConfigError) return error;
    throw new Error(`expected V2RuntimeConfigError, got: ${String(error)}`);
  }
  throw new Error('expected V2RuntimeConfigError, nothing was thrown');
};

describe('V2 runtime configuration gate (#150)', () => {
  describe('Node: NODE_ENV resolution', () => {
    it('treats an unset NODE_ENV as production', () => {
      const error = refusal(() => validateNodeV2Runtime({}));
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
      expect(error.message).toContain('production mode');
    });

    it('rejects an unknown NODE_ENV, naming the setting without its value', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({ NODE_ENV: 'staging' })
      );
      expect(error.message).toContain('NODE_ENV');
      expect(error.message).toContain('must be one of');
      // The value is never echoed, and unknown values never relax the rules:
      // the production origin requirement surfaces in the same refusal.
      expect(error.message).not.toContain('staging');
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
    });

    it.each(['development', 'test'] as const)(
      'still starts in %s mode without a public origin',
      (NODE_ENV) => {
        const config = validateNodeV2Runtime({ NODE_ENV });
        expect(config.environment).toBe(NODE_ENV);
        expect(config.productionLike).toBe(false);
        expect(config.publicOrigin).toBeUndefined();
      }
    );
  });

  describe('Node: HONO_PUBLIC_ORIGIN', () => {
    it('accepts a valid https origin in production', () => {
      const config = validateNodeV2Runtime({
        NODE_ENV: 'production',
        HONO_PUBLIC_ORIGIN: okOrigin,
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: okBootstrapSecret,
      });
      expect(config.publicOrigin).toBe(okOrigin);
      expect(config.secureCookies).toBe(true);
      expect(config.httpsRequired).toBe(true);
    });

    it('requires the setting in production and names it, never the value', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: 'https://change-me-zzq.example.org',
        })
      );
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
      expect(error.message).toContain('placeholder');
      // Fail closed without echoing the configured value.
      expect(error.message).not.toContain('change-me-zzq');
    });

    it.each([
      'change-me',
      'https://replace-with-your-origin.example.org',
      'https://REPLACE_WITH.example.org',
      'https://00000000-0000-0000-0000-000000000000.example.org',
      'https://example.org',
      'https://api.example.net',
      'https://your-origin.example.org',
      'https://cdn.example',
      'https://assets.terrastories.invalid',
    ])('refuses the placeholder value %s in production', (origin) => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: origin,
        })
      );
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
    });

    it('refuses placeholder values in development too', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'development',
          HONO_PUBLIC_ORIGIN: 'https://replace-with.example.org',
        })
      );
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
      expect(error.message).toContain('placeholder');
    });

    it('refuses a non-origin value in production', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: 'https://api.terrastories.org/community',
        })
      );
      expect(error.message).toContain(
        'HONO_PUBLIC_ORIGIN must be an origin without a path or query'
      );
    });

    it('refuses a loopback host in production but allows it in development', () => {
      expect(
        refusal(() =>
          validateNodeV2Runtime({
            NODE_ENV: 'production',
            HONO_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
          })
        ).message
      ).toContain('loopback');
      expect(
        validateNodeV2Runtime({
          NODE_ENV: 'development',
          HONO_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
        }).publicOrigin
      ).toBe('http://127.0.0.1:3000');
    });
  });

  describe('Node: Secure cookies follow the origin (PR #229 review)', () => {
    it('emits non-Secure cookies under the field-kit plain-HTTP opt-in', () => {
      const config = validateNodeV2Runtime({
        NODE_ENV: 'field-kit',
        HONO_PUBLIC_ORIGIN: 'http://field-kit.local:3000',
        HONO_ALLOW_PLAIN_HTTP: 'true',
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: okBootstrapSecret,
      });
      expect(config.secureCookies).toBe(false);
    });

    it('keeps Secure cookies for an https field-kit origin', () => {
      const config = validateNodeV2Runtime({
        NODE_ENV: 'field-kit',
        HONO_PUBLIC_ORIGIN: 'https://field-kit.local',
        HONO_ALLOW_PLAIN_HTTP: 'true',
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: okBootstrapSecret,
      });
      expect(config.secureCookies).toBe(true);
    });

    it('still refuses plain HTTP in production even with the opt-in flag', () => {
      refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: 'http://api.terrastories.org',
          HONO_ALLOW_PLAIN_HTTP: 'true',
        })
      );
    });

    it('refuses a padded http origin under the opt-in: the parsed origin governs', () => {
      // The URL parser trims padding, so the exact-origin rule refuses the
      // value; the Secure-cookie derivation reads the same parse, never a
      // raw string prefix (PR #229 review).
      refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'field-kit',
          HONO_PUBLIC_ORIGIN: ' http://field-kit.local:3000',
          HONO_ALLOW_PLAIN_HTTP: 'true',
        })
      );
    });
  });

  describe('hostname normalization (PR #229 review)', () => {
    it.each([
      'https://example.com.',
      'https://api.example.org.',
      'https://EXAMPLE.COM',
    ])('refuses documentation host %s', (origin) => {
      refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: origin,
        })
      );
    });

    it.each([
      'https://127.0.0.2',
      'https://localhost.',
      'https://app.localhost',
      'https://[0:0:0:0:0:0:0:1]',
    ])('refuses loopback host %s in production', (origin) => {
      refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: origin,
        })
      );
    });
  });

  describe('IPv4-mapped IPv6 loopback through full URLs (PR #229 review)', () => {
    // The URL parser serializes [::ffff:127.0.0.1] as the hex form
    // [::ffff:7f00:1], so the gate must recognize the hex spelling.
    it('refuses the canonical hex form as a loopback production origin', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: 'https://[::ffff:7f00:1]',
        })
      );
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
      expect(error.message).toContain('loopback');
    });

    it('refuses the mapped loopback under the field-kit plain-HTTP opt-in', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'field-kit',
          HONO_PUBLIC_ORIGIN: 'http://[::ffff:7f00:1]:3000',
          HONO_ALLOW_PLAIN_HTTP: 'true',
        })
      );
      expect(error.message).toContain('loopback');
    });

    it('refuses the dotted-quad spelling for not being the exact origin', () => {
      // [::ffff:127.0.0.1] is never the serialized form, so the exact-origin
      // rule catches it before the loopback rule needs to.
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: 'https://[::ffff:127.0.0.1]',
        })
      );
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
    });

    it('allows the mapped loopback in development, like every loopback', () => {
      expect(
        validateNodeV2Runtime({
          NODE_ENV: 'development',
          HONO_PUBLIC_ORIGIN: 'http://[::ffff:7f00:1]:3001',
        }).publicOrigin
      ).toBe('http://[::ffff:7f00:1]:3001');
    });

    it('keeps accepting a mapped non-loopback address', () => {
      expect(
        validateNodeV2Runtime({
          NODE_ENV: 'field-kit',
          HONO_PUBLIC_ORIGIN: 'http://[::ffff:6501:203]:3000',
          HONO_ALLOW_PLAIN_HTTP: 'true',
          AUTH_SERVER_SECRET: okSecret,
          BOOTSTRAP_SECRET: okBootstrapSecret,
        }).publicOrigin
      ).toBe('http://[::ffff:6501:203]:3000');
    });
  });

  describe('unspecified bind-any hosts (PR #229 review)', () => {
    it.each(['https://0.0.0.0', 'https://[::]'])(
      'refuses %s as a production origin',
      (origin) => {
        const error = refusal(() =>
          validateNodeV2Runtime({
            NODE_ENV: 'production',
            HONO_PUBLIC_ORIGIN: origin,
          })
        );
        expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
        expect(error.message).toContain('unspecified');
      }
    );
  });

  describe('relaxed modes cannot hide behind a deployed origin (PR #229 review)', () => {
    it.each(['development', 'test'] as const)(
      'refuses NODE_ENV=%s with an https non-loopback origin',
      (NODE_ENV) => {
        const error = refusal(() =>
          validateNodeV2Runtime({
            NODE_ENV,
            HONO_PUBLIC_ORIGIN: okOrigin,
          })
        );
        expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
        expect(error.message).toContain('production deployment signal');
        expect(error.message).toContain('NODE_ENV');
      }
    );

    it('refuses the same signal on the Workers binding set', () => {
      const error = refusal(() =>
        validateWorkerV2Runtime({
          DB: {},
          MEDIA: {},
          ENVIRONMENT: 'development',
          PUBLIC_ORIGIN: okOrigin,
        } as unknown as Parameters<typeof validateWorkerV2Runtime>[0])
      );
      expect(error.message).toContain('PUBLIC_ORIGIN');
      expect(error.message).toContain('ENVIRONMENT');
    });

    it('still accepts development on a loopback https origin', () => {
      expect(
        validateNodeV2Runtime({
          NODE_ENV: 'development',
          HONO_PUBLIC_ORIGIN: 'https://localhost:8443',
        }).publicOrigin
      ).toBe('https://localhost:8443');
    });

    it('still accepts development with no origin at all', () => {
      expect(
        validateNodeV2Runtime({ NODE_ENV: 'development' }).publicOrigin
      ).toBeUndefined();
    });

    it('exposes a one-line content-free mode marker for relaxed modes only', () => {
      const dev = v2RuntimeModeNotice(
        validateNodeV2Runtime({ NODE_ENV: 'development' })
      );
      expect(dev).toContain('development');
      expect(
        v2RuntimeModeNotice(validateNodeV2Runtime({ NODE_ENV: 'test' }))
      ).toContain('test');
      expect(
        v2RuntimeModeNotice(
          validateNodeV2Runtime({
            NODE_ENV: 'production',
            HONO_PUBLIC_ORIGIN: okOrigin,
            AUTH_SERVER_SECRET: okSecret,
            BOOTSTRAP_SECRET: okBootstrapSecret,
          })
        )
      ).toBeUndefined();
      expect(
        v2RuntimeModeNotice(
          validateNodeV2Runtime({
            NODE_ENV: 'field-kit',
            HONO_PUBLIC_ORIGIN: 'http://field-kit.local:3000',
            HONO_ALLOW_PLAIN_HTTP: 'true',
            AUTH_SERVER_SECRET: okSecret,
            BOOTSTRAP_SECRET: okBootstrapSecret,
          })
        )
      ).toBeUndefined();
    });
  });

  describe('plain-HTTP rule (SPEC-V2 §7 field-kit exception)', () => {
    const httpOrigin = 'http://field-kit.local:3000';

    it('refuses http in production even with the explicit opt-in', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: httpOrigin,
          HONO_ALLOW_PLAIN_HTTP: 'true',
        })
      );
      expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
      expect(error.message).toContain('https');
    });

    it.each(['field-kit', 'offline'] as const)(
      'refuses http in %s mode without the opt-in',
      (NODE_ENV) => {
        const error = refusal(() =>
          validateNodeV2Runtime({ NODE_ENV, HONO_PUBLIC_ORIGIN: httpOrigin })
        );
        expect(error.message).toContain('HONO_PUBLIC_ORIGIN');
        expect(error.message).toContain('opt-in');
      }
    );

    it.each(['field-kit', 'offline'] as const)(
      'accepts http in %s mode with the explicit opt-in',
      (NODE_ENV) => {
        const config = validateNodeV2Runtime({
          NODE_ENV,
          HONO_PUBLIC_ORIGIN: httpOrigin,
          HONO_ALLOW_PLAIN_HTTP: 'true',
          AUTH_SERVER_SECRET: okSecret,
          BOOTSTRAP_SECRET: okBootstrapSecret,
        });
        expect(config.httpsRequired).toBe(false);
        expect(config.publicOrigin).toBe(httpOrigin);
      }
    );

    it('accepts http in development without any opt-in', () => {
      const config = validateNodeV2Runtime({
        NODE_ENV: 'development',
        HONO_PUBLIC_ORIGIN: httpOrigin,
      });
      expect(config.httpsRequired).toBe(false);
    });
  });

  describe('CORS origins', () => {
    it('refuses a wildcard entry with credentials enabled', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          HONO_CORS_ORIGINS: '*',
        })
      );
      expect(error.message).toContain('HONO_CORS_ORIGINS');
      expect(error.message).toContain('wildcard');
    });

    it('refuses an http entry where https is required', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          HONO_CORS_ORIGINS: 'http://insecure.lan:5173',
        })
      );
      expect(error.message).toContain('HONO_CORS_ORIGINS');
      expect(error.message).toContain('https');
    });

    it('accepts development http entries and parses the comma list', () => {
      const config = validateNodeV2Runtime({
        NODE_ENV: 'development',
        HONO_CORS_ORIGINS:
          ' http://localhost:5173 , https://app.terrastories.org ,',
      });
      expect(config.corsOrigins).toEqual([
        'http://localhost:5173',
        'https://app.terrastories.org',
      ]);
    });

    it('refuses a placeholder CORS entry', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          HONO_CORS_ORIGINS: 'https://replace-with-your-app.example.org',
        })
      );
      expect(error.message).toContain('HONO_CORS_ORIGINS');
      expect(error.message).toContain('placeholder');
    });

    it('treats an empty CORS list as same-origin-only and accepts it', () => {
      expect(
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          HONO_CORS_ORIGINS: '',
          AUTH_SERVER_SECRET: okSecret,
          BOOTSTRAP_SECRET: okBootstrapSecret,
        }).corsOrigins
      ).toEqual([]);
    });
  });

  describe('session cookie Secure flag', () => {
    it('derives non-Secure cookies for development only', () => {
      expect(
        validateNodeV2Runtime({ NODE_ENV: 'development' }).secureCookies
      ).toBe(false);
      expect(
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          AUTH_SERVER_SECRET: okSecret,
          BOOTSTRAP_SECRET: okBootstrapSecret,
        }).secureCookies
      ).toBe(true);
    });

    it('refuses non-Secure cookies where https is required', () => {
      const error = refusal(() =>
        validateV2RuntimeCore({
          environment: 'production',
          publicOrigin: okOrigin,
          secureCookies: false,
          authServerSecret: okSecret,
          names: {
            environment: 'NODE_ENV',
            publicOrigin: 'HONO_PUBLIC_ORIGIN',
            corsOrigins: 'HONO_CORS_ORIGINS',
            secureCookies: 'secureCookies',
            authServerSecret: 'AUTH_SERVER_SECRET',
          },
        })
      );
      expect(error.message).toContain('secureCookies');
      expect(error.message).toContain('must stay enabled');
    });

    it('allows non-Secure cookies under the field-kit plain-HTTP opt-in', () => {
      const config = validateV2RuntimeCore({
        environment: 'field-kit',
        publicOrigin: 'http://field-kit.local:3000',
        secureCookies: false,
        allowPlainHttp: true,
        authServerSecret: okSecret,
        bootstrapSecret: okBootstrapSecret,
        names: {
          environment: 'NODE_ENV',
          publicOrigin: 'HONO_PUBLIC_ORIGIN',
          corsOrigins: 'HONO_CORS_ORIGINS',
          secureCookies: 'secureCookies',
          authServerSecret: 'AUTH_SERVER_SECRET',
        },
      });
      expect(config.secureCookies).toBe(false);
    });
  });

  describe('Node: HONO_PORT', () => {
    it.each(['0', '70000', 'abc', '3.5'])('refuses %s', (port) => {
      expect(
        refusal(() => validateNodeV2Runtime({ HONO_PORT: port })).message
      ).toContain('HONO_PORT');
    });

    it('defaults to 3001 and accepts a valid port', () => {
      expect(validateNodeV2Runtime({ NODE_ENV: 'test' }).port).toBe(3001);
      expect(
        validateNodeV2Runtime({ NODE_ENV: 'test', HONO_PORT: '3999' }).port
      ).toBe(3999);
    });
  });

  describe('Workers: ENVIRONMENT and bindings', () => {
    const bindings = {
      DB: {},
      MEDIA: {},
    } as unknown as Parameters<typeof validateWorkerV2Runtime>[0];

    it('treats an unset ENVIRONMENT as production and requires PUBLIC_ORIGIN', () => {
      const error = refusal(() => validateWorkerV2Runtime({ ...bindings }));
      expect(error.message).toContain('PUBLIC_ORIGIN');
      expect(error.message).toContain('production mode');
    });

    it('serves a fully valid production configuration', () => {
      const config = validateWorkerV2Runtime({
        ...bindings,
        PUBLIC_ORIGIN: okOrigin,
        CORS_ORIGINS: 'https://app.terrastories.org',
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: okBootstrapSecret,
      });
      expect(config.environment).toBe('production');
      expect(config.httpsRequired).toBe(true);
      expect(config.secureCookies).toBe(true);
    });

    it('refuses the committed template placeholder origin', () => {
      const error = refusal(() =>
        validateWorkerV2Runtime({
          ...bindings,
          PUBLIC_ORIGIN: 'https://example.org',
        })
      );
      expect(error.message).toContain('PUBLIC_ORIGIN');
      expect(error.message).toContain('placeholder');
    });

    it.each(['development', 'test'] as const)(
      'still serves in ENVIRONMENT=%s without a public origin',
      (ENVIRONMENT) => {
        const config = validateWorkerV2Runtime({ ...bindings, ENVIRONMENT });
        expect(config.productionLike).toBe(false);
      }
    );

    it('rejects an unknown ENVIRONMENT value, naming the setting', () => {
      const error = refusal(() =>
        validateWorkerV2Runtime({ ...bindings, ENVIRONMENT: 'staging' })
      );
      expect(error.message).toContain('ENVIRONMENT');
    });

    it('never offers the plain-HTTP opt-in on the hosted profile', () => {
      const error = refusal(() =>
        validateWorkerV2Runtime({
          ...bindings,
          ENVIRONMENT: 'field-kit',
          PUBLIC_ORIGIN: 'http://field-kit.local:3000',
        })
      );
      expect(error.message).toContain('PUBLIC_ORIGIN');
      expect(error.message).toContain('https');
    });

    it('refuses missing service bindings by name', () => {
      const error = refusal(() =>
        validateWorkerV2Runtime({
          ENVIRONMENT: 'test',
          DB: {},
        } as unknown as Parameters<typeof validateWorkerV2Runtime>[0])
      );
      expect(error.message).toContain('MEDIA R2 binding is missing');
      const both = refusal(() =>
        validateWorkerV2Runtime({
          ENVIRONMENT: 'test',
        } as unknown as Parameters<typeof validateWorkerV2Runtime>[0])
      );
      expect(both.message).toContain('DB D1 binding is missing');
      expect(both.message).toContain('MEDIA R2 binding is missing');
    });
  });
  describe('V2 prelogin AUTH_SERVER_SECRET (#137)', () => {
    it('requires the secret in production and names only the setting', () => {
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
        })
      );
      expect(error.message).toContain('AUTH_SERVER_SECRET');
      expect(error.message).toContain('required');
      expect(error.message).not.toContain(okSecret);
    });

    it('requires the secret on the Workers binding set', () => {
      const error = refusal(() =>
        validateWorkerV2Runtime({
          DB: {},
          MEDIA: {},
          PUBLIC_ORIGIN: okOrigin,
        } as unknown as Parameters<typeof validateWorkerV2Runtime>[0])
      );
      expect(error.message).toContain('AUTH_SERVER_SECRET');
      expect(error.message).toContain('required');
      expect(error.message).not.toContain(okSecret);
    });

    it('requires the secret in field-kit and offline mode too', () => {
      for (const NODE_ENV of ['field-kit', 'offline'] as const) {
        const error = refusal(() =>
          validateNodeV2Runtime({
            NODE_ENV,
            HONO_PUBLIC_ORIGIN: 'https://field-kit.local',
          })
        );
        expect(error.message).toContain('AUTH_SERVER_SECRET');
      }
    });

    it('refuses a sub-32-character secret without echoing it', () => {
      const short = 'short-secret-1234';
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          AUTH_SERVER_SECRET: short,
        })
      );
      expect(error.message).toContain('AUTH_SERVER_SECRET');
      expect(error.message).toContain('32 characters');
      expect(error.message).not.toContain(short);
    });

    it('refuses a placeholder secret without echoing it', () => {
      const placeholderValue = 'replace-with-prelogin-secret-0123456789abcdef';
      const error = refusal(() =>
        validateNodeV2Runtime({
          NODE_ENV: 'production',
          HONO_PUBLIC_ORIGIN: okOrigin,
          AUTH_SERVER_SECRET: placeholderValue,
        })
      );
      expect(error.message).toContain('AUTH_SERVER_SECRET');
      expect(error.message).toContain('placeholder');
      expect(error.message).not.toContain('replace-with');
    });

    it('starts in development and test without the secret', () => {
      for (const NODE_ENV of ['development', 'test'] as const) {
        expect(
          validateNodeV2Runtime({ NODE_ENV }).serverSecret
        ).toBeUndefined();
        expect(
          validateWorkerV2Runtime({
            ENVIRONMENT: NODE_ENV,
            DB: {},
            MEDIA: {},
          } as unknown as Parameters<typeof validateWorkerV2Runtime>[0])
            .serverSecret
        ).toBeUndefined();
      }
    });

    it('carries a compliant secret through to the config without logging it', () => {
      const config = validateNodeV2Runtime({
        NODE_ENV: 'production',
        HONO_PUBLIC_ORIGIN: okOrigin,
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: okBootstrapSecret,
      });
      expect(config.serverSecret).toBe(okSecret);
      expect(v2RuntimeModeNotice(config)).toBeUndefined();
      // v2RuntimeModeNotice is content-free and never recites the secret.
      expect(v2RuntimeModeNotice(config) ?? '').not.toContain(okSecret);
    });
  });

  describe('V2 installation bootstrap secret (#252, 11b round 5)', () => {
    it('refuses a short secret padded with spaces to reach 24+ characters', () => {
      const paddedShort = '   ' + 'b'.repeat(20) + '   ';
      expect(paddedShort.length).toBeGreaterThanOrEqual(24);
      expect(paddedShort.trim().length).toBeLessThan(24);

      for (const invoke of [
        () =>
          validateWorkerV2Runtime({
            DB: {},
            MEDIA: {},
            PUBLIC_ORIGIN: okOrigin,
            AUTH_SERVER_SECRET: okSecret,
            BOOTSTRAP_SECRET: paddedShort,
          } as unknown as Parameters<typeof validateWorkerV2Runtime>[0]),
        () =>
          validateNodeV2Runtime({
            NODE_ENV: 'production',
            HONO_PUBLIC_ORIGIN: okOrigin,
            AUTH_SERVER_SECRET: okSecret,
            BOOTSTRAP_SECRET: paddedShort,
          }),
      ]) {
        const error = refusal(invoke);
        expect(error.message).toContain('BOOTSTRAP_SECRET');
        expect(error.message).toContain('24 characters');
        expect(error.message).not.toContain('bbbb');
      }
    });

    it('refuses a whitespace-only value of 24+ spaces', () => {
      const spacesOnly = ' '.repeat(30);

      for (const invoke of [
        () =>
          validateWorkerV2Runtime({
            DB: {},
            MEDIA: {},
            PUBLIC_ORIGIN: okOrigin,
            AUTH_SERVER_SECRET: okSecret,
            BOOTSTRAP_SECRET: spacesOnly,
          } as unknown as Parameters<typeof validateWorkerV2Runtime>[0]),
        () =>
          validateNodeV2Runtime({
            NODE_ENV: 'production',
            HONO_PUBLIC_ORIGIN: okOrigin,
            AUTH_SERVER_SECRET: okSecret,
            BOOTSTRAP_SECRET: spacesOnly,
          }),
      ]) {
        const error = refusal(invoke);
        expect(error.message).toContain('BOOTSTRAP_SECRET');
        expect(error.message).toContain('required');
      }
    });

    it('trims surrounding whitespace on a compliant 24+ character secret', () => {
      const paddedValid = '  ' + okBootstrapSecret + '  ';

      const workerConfig = validateWorkerV2Runtime({
        DB: {},
        MEDIA: {},
        PUBLIC_ORIGIN: okOrigin,
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: paddedValid,
      } as unknown as Parameters<typeof validateWorkerV2Runtime>[0]);
      expect(workerConfig.bootstrapSecret).toBe(okBootstrapSecret);

      const nodeConfig = validateNodeV2Runtime({
        NODE_ENV: 'production',
        HONO_PUBLIC_ORIGIN: okOrigin,
        AUTH_SERVER_SECRET: okSecret,
        BOOTSTRAP_SECRET: paddedValid,
      });
      expect(nodeConfig.bootstrapSecret).toBe(okBootstrapSecret);
    });
  });
});
