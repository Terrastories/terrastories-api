import { describe, it, expect, vi } from 'vitest';
import { createWorker, type WorkerBindings } from '../../src/worker.js';
import {
  KNOWN_WORKERS_PLANS,
  V2RuntimeConfigError,
  type WorkersPlan,
  parseWorkersPlan,
  validateNodeV2Runtime,
  validateV2RuntimeCore,
  validateWorkerV2Runtime,
  v2RuntimeModeNotice,
} from '../../src/config/v2-runtime.js';
import {
  type MediaCleanupCoordinator,
  WORKER_PAID_SWEEP_SUBREQUEST_BUDGET,
  WORKER_SWEEP_SUBREQUEST_BUDGET,
  workerSweepSubrequestBudget,
} from '../../src/services/media-cleanup.service.js';
import {
  EXPORT_SWEEP_BATCH_LIMIT,
  NODE_EXPORT_MAX_ARCHIVE_BYTES,
  WORKER_EXPORT_SWEEP_BATCH_LIMIT,
  WORKER_PAID_EXPORT_SWEEP_BATCH_LIMIT,
  WORKERS_EXPORT_MAX_ARCHIVE_BYTES,
  WORKERS_EXPORT_MAX_FILES,
  WORKERS_EXPORT_MAX_MEDIA_BYTES,
  WORKERS_EXPORT_MAX_ROWS,
  WORKERS_PAID_EXPORT_MAX_ARCHIVE_BYTES,
  WORKERS_PAID_EXPORT_MAX_FILES,
  WORKERS_PAID_EXPORT_MAX_MEDIA_BYTES,
  WORKERS_PAID_EXPORT_MAX_ROWS,
  exportLimitsForProfile,
  workerExportSweepBatchLimit,
} from '../../src/shared/export-policy.js';
import {
  CommunityErasureService,
  ERASURE_PASS_MAX_WALL_MS,
  WORKER_ERASURE_STORAGE_BUDGET,
  WORKER_PAID_ERASURE_D1_BUDGET,
  WORKER_PAID_ERASURE_STORAGE_BUDGET,
  workerErasureD1Budget,
  workerErasureStorageBudget,
} from '../../src/services/community-erasure.service.js';
import { CommunityExportService } from '../../src/services/community-export.service.js';
import type { CommunityExportRepository } from '../../src/repositories/community-export.repository.js';
import type { CommunitySovereigntyRepository } from '../../src/repositories/community-sovereignty.repository.js';
import type { ErasureRecord } from '../../src/services/erasure-record-store.js';
import {
  D1_FREE_DAILY_ROWS_WRITTEN,
  D1_PAID_INCLUDED_ROWS_WRITTEN,
  d1RowsWrittenBudget,
} from '../../src/migration/v2/load.js';
import {
  ImportsService,
  WORKER_FREE_DAILY_IMPORT_LIMIT,
  WORKER_PAID_DAILY_IMPORT_LIMIT,
  workerDailyImportLimit,
} from '../../src/services/imports.service.js';
import type { ImportsRepository } from '../../src/repositories/imports.repository.js';
import type { FoundationStorage } from '../../src/services/hono-foundation.service.js';

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

  describe('Workers: WORKERS_PLAN and plan-switched constants (#295)', () => {
    const bindings = {
      DB: {},
      MEDIA: {},
    } as unknown as Parameters<typeof validateWorkerV2Runtime>[0];

    it('defaults WORKERS_PLAN to free when unset or empty', () => {
      expect(KNOWN_WORKERS_PLANS).toEqual(['free', 'paid']);
      expect(parseWorkersPlan(undefined)).toBe('free');
      expect(parseWorkersPlan('')).toBe('free');
      expect(
        validateWorkerV2Runtime({
          ...bindings,
          ENVIRONMENT: 'test',
        }).workersPlan
      ).toBe('free');
      expect(
        validateWorkerV2Runtime({
          ...bindings,
          ENVIRONMENT: 'test',
          WORKERS_PLAN: '',
        }).workersPlan
      ).toBe('free');
    });

    it('accepts explicit free and paid WORKERS_PLAN values', () => {
      for (const WORKERS_PLAN of ['free', 'paid'] as const) {
        expect(parseWorkersPlan(WORKERS_PLAN)).toBe(WORKERS_PLAN);
        const config = validateWorkerV2Runtime({
          ...bindings,
          PUBLIC_ORIGIN: okOrigin,
          AUTH_SERVER_SECRET: okSecret,
          BOOTSTRAP_SECRET: okBootstrapSecret,
          WORKERS_PLAN,
        });
        expect(config.workersPlan).toBe(WORKERS_PLAN);
      }
    });

    it.each(['enterprise', 'FREE', 'PAID', ' free ', 'paid ', 'true', '1'])(
      'fails closed on invalid WORKERS_PLAN=%s without echoing the value',
      (invalidPlan) => {
        const parseErr = refusal(() => parseWorkersPlan(invalidPlan));
        expect(parseErr.message).toContain('WORKERS_PLAN');
        expect(parseErr.message).toContain('must be one of free, paid');
        if (!['free', 'paid'].includes(invalidPlan.trim().toLowerCase())) {
          expect(parseErr.message).not.toContain(invalidPlan);
        }

        const workerErr = refusal(() =>
          validateWorkerV2Runtime({
            ...bindings,
            ENVIRONMENT: 'test',
            WORKERS_PLAN: invalidPlan,
          })
        );
        expect(workerErr.message).toContain('WORKERS_PLAN');
        expect(workerErr.message).toContain('must be one of free, paid');
      }
    );

    it('preserves Free constants by default and switches each constant on paid', () => {
      // 1. Media cleanup orphan sweep subrequest budget
      expect(WORKER_SWEEP_SUBREQUEST_BUDGET).toBe(40);
      expect(WORKER_PAID_SWEEP_SUBREQUEST_BUDGET).toBe(1000);
      expect(workerSweepSubrequestBudget()).toBe(40);
      expect(workerSweepSubrequestBudget('free')).toBe(40);
      expect(workerSweepSubrequestBudget('paid')).toBe(1000);

      // 2. Community export limits & sweep batch limit
      expect(WORKERS_EXPORT_MAX_ROWS).toBe(10_000);
      expect(WORKERS_EXPORT_MAX_FILES).toBe(30);
      expect(WORKERS_EXPORT_MAX_MEDIA_BYTES).toBe(50 * 1024 * 1024);
      expect(WORKERS_EXPORT_MAX_ARCHIVE_BYTES).toBe(64 * 1024 * 1024);
      expect(WORKERS_PAID_EXPORT_MAX_ROWS).toBe(10_000);
      expect(WORKERS_PAID_EXPORT_MAX_FILES).toBe(30);
      expect(WORKERS_PAID_EXPORT_MAX_MEDIA_BYTES).toBe(50 * 1024 * 1024);
      expect(WORKERS_PAID_EXPORT_MAX_ARCHIVE_BYTES).toBe(64 * 1024 * 1024);

      expect(exportLimitsForProfile(true)).toEqual({
        maxRows: 10_000,
        maxFiles: 30,
        maxMediaBytes: 50 * 1024 * 1024,
        maxArchiveBytes: 64 * 1024 * 1024,
        maxManifestBytes: 8 * 1024 * 1024,
      });
      expect(exportLimitsForProfile(true, 'free')).toEqual(
        exportLimitsForProfile(true)
      );
      expect(exportLimitsForProfile(true, 'paid')).toEqual(
        exportLimitsForProfile(true)
      );

      // Node/self-hosted profiles are unaffected regardless of plan
      const expectedNodeLimits = {
        maxRows: Number.MAX_SAFE_INTEGER,
        maxFiles: Number.MAX_SAFE_INTEGER,
        maxMediaBytes: NODE_EXPORT_MAX_ARCHIVE_BYTES,
        maxArchiveBytes: NODE_EXPORT_MAX_ARCHIVE_BYTES,
        maxManifestBytes: 64 * 1024 * 1024,
      };
      expect(exportLimitsForProfile(false)).toEqual(expectedNodeLimits);
      expect(exportLimitsForProfile(false, 'free')).toEqual(expectedNodeLimits);
      expect(exportLimitsForProfile(false, 'paid')).toEqual(expectedNodeLimits);

      expect(WORKER_EXPORT_SWEEP_BATCH_LIMIT).toBe(5);
      expect(WORKER_PAID_EXPORT_SWEEP_BATCH_LIMIT).toBe(
        EXPORT_SWEEP_BATCH_LIMIT
      );
      expect(workerExportSweepBatchLimit()).toBe(5);
      expect(workerExportSweepBatchLimit('free')).toBe(5);
      expect(workerExportSweepBatchLimit('paid')).toBe(20);

      // 3. Community erasure storage & D1 query budgets
      expect(WORKER_ERASURE_STORAGE_BUDGET).toBe(15);
      expect(WORKER_PAID_ERASURE_STORAGE_BUDGET).toBe(400);
      expect(WORKER_PAID_ERASURE_D1_BUDGET).toBe(400);
      expect(ERASURE_PASS_MAX_WALL_MS).toBe(45_000);
      expect(workerErasureStorageBudget()).toBe(15);
      expect(workerErasureStorageBudget('free')).toBe(15);
      expect(workerErasureStorageBudget('paid')).toBe(400);
      expect(workerErasureD1Budget()).toBeUndefined();
      expect(workerErasureD1Budget('free')).toBeUndefined();
      expect(workerErasureD1Budget('paid')).toBe(400);

      // 4. Migration load D1 rows-written budget
      expect(D1_FREE_DAILY_ROWS_WRITTEN).toBe(100_000);
      expect(D1_PAID_INCLUDED_ROWS_WRITTEN).toBe(50_000_000);
      expect(d1RowsWrittenBudget()).toBe(100_000);
      expect(d1RowsWrittenBudget('free')).toBe(100_000);
      expect(d1RowsWrittenBudget('paid')).toBe(50_000_000);

      // 5. Daily committed imports limit on D1 (retained on Paid until SPEC-V2 §4/§5/§7 amendment)
      expect(WORKER_FREE_DAILY_IMPORT_LIMIT).toBe(1);
      expect(WORKER_PAID_DAILY_IMPORT_LIMIT).toBe(1);
      expect(workerDailyImportLimit()).toBe(1);
      expect(workerDailyImportLimit('free')).toBe(1);
      expect(workerDailyImportLimit('paid')).toBe(1);
    });

    it('keeps 429 d1_daily_import_limit on Free and Paid in ImportsService until SPEC-V2 is amended', async () => {
      const fakeRepo = {
        connection: {},
        hasD1Batch: () => true,
        activeCommunityExists: async () => true,
        hasCommittedImportInWindow: async () => true,
        countOpenPreviews: async () => 0,
      } as unknown as ImportsRepository;
      const fakeStorage: FoundationStorage = {
        read: async () => null,
        put: async () => ({ size: 0 }),
        delete: async () => {},
      };
      const fakeCleanup = {
        deleteStorageBestEffort: async () => {},
        deleteFilesBestEffort: async () => {},
      } as unknown as MediaCleanupCoordinator;
      const actor = {
        id: 1,
        email: 'admin@community.local',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        communityId: 1,
      };

      for (const workersPlan of ['free', 'paid'] as const) {
        const service = new ImportsService(fakeRepo, fakeStorage, fakeCleanup, {
          enforceD1Budget: true,
          workersPlan,
        });
        const preview = await service.previewImport({
          actor,
          contentTypeHeader: 'multipart/form-data; boundary=---x',
          contentLengthHeader: '10',
          body: null,
        });
        expect(preview.status).toBe(429);
        expect(preview.body).toMatchObject({
          code: 'd1_daily_import_limit',
        });
      }
    });

    it('names Workers Free or Workers Paid accurately in 422 export limit responses', async () => {
      const fakeExportRepo = {
        findJobsNeedingCleanup: async () => [],
        reserveExportJob: async () => ({ status: 'reserved' as const }),
        readCommunityExportSnapshot: async () => ({
          community: { id: 1 },
          mapConfig: null,
          users: [{ id: 1 }, { id: 2 }],
          places: [],
          speakers: [],
          stories: [],
          storyPlaces: [],
          storySpeakers: [],
          files: [],
          attachments: [],
          externalMediaLinks: [],
          legacyCommunityMedia: [],
          importManifests: [],
          auditEntries: [],
        }),
        failExportJob: async () => {},
      } as unknown as CommunityExportRepository;
      const fakeStorage: FoundationStorage = {
        read: async () => null,
        put: async () => ({ size: 0 }),
        delete: async () => {},
      };
      const admin = {
        id: 1,
        email: 'admin@community.local',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin' as const,
        communityId: 1,
        tokenVersion: 0,
        passwordHash: '',
      };

      const freeExport = new CommunityExportService(
        fakeExportRepo,
        fakeStorage,
        {
          isWorkers: true,
          workersPlan: 'free',
          limits: { maxRows: 1 },
        }
      );
      const freeRes = await freeExport.createExport(admin);
      expect(freeRes.status).toBe(422);
      expect(freeRes.body).toEqual({
        error:
          'Export exceeds Workers Free maxRows limit; run export from a self-hosted or field-kit deployment profile',
        code: 'export_limit_exceeded',
      });

      const paidExport = new CommunityExportService(
        fakeExportRepo,
        fakeStorage,
        {
          isWorkers: true,
          workersPlan: 'paid',
          limits: { maxRows: 1 },
        }
      );
      const paidRes = await paidExport.createExport(admin);
      expect(paidRes.status).toBe(422);
      expect(paidRes.body).toEqual({
        error:
          'Export exceeds Workers Paid maxRows limit; run export from a self-hosted or field-kit deployment profile',
        code: 'export_limit_exceeded',
      });
    });

    it('counts D1 queries in the Paid erasure budget under 1,000, stops at ERASURE_PASS_MAX_WALL_MS, and leaves Free unchanged', async () => {
      const makeFiles = (count: number) =>
        Array.from({ length: count }, (_, idx) => ({
          id: `f${idx + 1}`,
          storageKey: `users/7/avatar-${idx + 1}.png`,
          path: null,
        }));
      const runScenario = async (
        fileCount: number,
        storageBudget: number,
        d1Budget?: number,
        workersPlan?: WorkersPlan
      ) => {
        const legacyFiles = makeFiles(fileCount);
        const cleared: string[] = [];
        let d1Queries = 0;
        let clockMs = 1_000;
        const records: ErasureRecord[] = [
          {
            communityId: 1,
            requestId: 'req-1',
            requestingActorId: null,
            requestedAt: new Date(0).toISOString(),
            completedAt: null,
            outcome: 'pending',
          },
        ];
        const repo = {
          activateDueErasures: async () => {
            d1Queries += 2;
            return true;
          },
          erasureWork: async () => {
            d1Queries += 2;
            return [];
          },
          erasureUploads: async () => {
            d1Queries += 1;
            return [];
          },
          erasureArchiveCustody: async () => {
            d1Queries += 1;
            return null;
          },
          erasureLegacyFiles: async () => {
            d1Queries += 1;
            return [...legacyFiles];
          },
          erasureMayDeleteKey: async () => {
            d1Queries += 2;
            return false;
          },
          clearErasureLegacyFile: async (_c: number, id: string) => {
            d1Queries += 1;
            cleared.push(id);
            const idx = legacyFiles.findIndex((f) => f.id === id);
            if (idx >= 0) legacyFiles.splice(idx, 1);
          },
          eraseRows: async () => {
            d1Queries += 23;
          },
        } as unknown as CommunitySovereigntyRepository;
        const storage: FoundationStorage = {
          read: async () => null,
          delete: async () => {},
          fenceCommunity: async () => {},
          list: async () => ({ entries: [], truncated: false }),
          erasureDeleteCost: 3,
        };
        const store = {
          list: async () => records,
          write: async (r: ErasureRecord) => {
            records[0] = r;
          },
        };
        const service = new CommunityErasureService(
          repo,
          storage,
          store,
          () => new Date(clockMs)
        );
        await service.sweep(new Date(0), storageBudget, d1Budget, workersPlan);
        return {
          cleared,
          remainingIds: legacyFiles.map((f) => f.id),
          d1Queries,
          service,
          storage,
          advanceClock: (ms: number) => {
            clockMs += ms;
          },
        };
      };

      // Paid D1 budget (27): 19 startup + 1 custody + 1 legacy list = 21 -> 6
      // remaining; each shared users/ key costs 3 D1 queries, so f1 and f2
      // clear (6 -> 0) and f3 stops before exceeding the D1 budget.
      const smallPaid = await runScenario(
        3,
        WORKER_PAID_ERASURE_STORAGE_BUDGET,
        27,
        'paid'
      );
      expect(smallPaid.cleared).toEqual(['f1', 'f2']);
      expect(smallPaid.remainingIds).toEqual(['f3']);

      // Full Paid budgets (400 storage, 400 D1): 200 shared users/ keys would
      // run 600+ D1 queries without D1 accounting; counting D1 queries stops
      // the pass well under D1's 1,000-query per-invocation ceiling.
      const fullPaid = await runScenario(
        200,
        workerErasureStorageBudget('paid'),
        workerErasureD1Budget('paid'),
        'paid'
      );
      expect(fullPaid.d1Queries).toBeLessThan(1000);
      expect(fullPaid.d1Queries).toBeLessThanOrEqual(
        WORKER_PAID_ERASURE_D1_BUDGET
      );
      expect(fullPaid.remainingIds.length).toBeGreaterThan(0);

      // Wall-clock deadline still halts mid-pass on Paid before the next minute tick.
      smallPaid.storage.fenceCommunity = async () => {
        smallPaid.advanceClock(ERASURE_PASS_MAX_WALL_MS);
      };
      await smallPaid.service.sweep(
        new Date(60_000),
        workerErasureStorageBudget('paid'),
        workerErasureD1Budget('paid'),
        'paid'
      );
      expect(smallPaid.remainingIds).toEqual(['f3']);

      // Without Paid plan or explicit D1 budget, storageBudget > 25 does not
      // trigger a D1 budget or the 45 s wall-clock deadline heuristic.
      const highBudgetNoPlan = await runScenario(200, 200);
      expect(highBudgetNoPlan.cleared).toHaveLength(196);
      expect(highBudgetNoPlan.d1Queries).toBeGreaterThan(
        WORKER_PAID_ERASURE_D1_BUDGET
      );

      // Free behavior is unchanged: 10 shared users/ keys under budget 15
      // still clear all 10 in one pass (1 fence + 10 * 1 skipped = 11 <= 15).
      const freeRun = await runScenario(
        10,
        workerErasureStorageBudget('free'),
        workerErasureD1Budget('free'),
        'free'
      );
      expect(freeRun.cleared).toHaveLength(10);
      expect(freeRun.remainingIds).toEqual([]);
    });

    it('keeps Free erasure sweep free of wall-clock and D1 cutoffs even with a slow clock', async () => {
      let clockMs = 1_000;
      const legacyFiles = [
        { id: 'lf-1', storageKey: 'legacy/one.png', path: null },
      ];
      const objects = ['communities/1/media/photo.png'];
      const erased: number[] = [];
      const records: ErasureRecord[] = [
        {
          communityId: 1,
          requestId: 'req-free-slow',
          requestingActorId: null,
          requestedAt: new Date(0).toISOString(),
          completedAt: null,
          outcome: 'pending',
        },
      ];
      const repo = {
        activateDueErasures: async () => true,
        erasureWork: async () => [],
        erasureUploads: async () => [],
        erasureArchiveCustody: async () => null,
        erasureLegacyFiles: async () => [...legacyFiles],
        erasureMayDeleteKey: async () => true,
        clearErasureLegacyFile: async (_c: number, id: string) => {
          const idx = legacyFiles.findIndex((f) => f.id === id);
          if (idx >= 0) legacyFiles.splice(idx, 1);
        },
        eraseRows: async (id: number) => {
          erased.push(id);
        },
      } as unknown as CommunitySovereigntyRepository;
      const deleteMany = vi.fn(async (keys: string[]) => {
        for (const key of keys) {
          const idx = objects.indexOf(key);
          if (idx >= 0) objects.splice(idx, 1);
        }
      });
      const storage: FoundationStorage = {
        read: async () => null,
        delete: async (key: string) => {
          if (key === 'legacy/one.png') {
            clockMs += ERASURE_PASS_MAX_WALL_MS + 10_000;
          }
        },
        deleteMany,
        fenceCommunity: async () => {
          clockMs += ERASURE_PASS_MAX_WALL_MS + 10_000;
        },
        list: async ({ prefix } = {}) => {
          clockMs += ERASURE_PASS_MAX_WALL_MS + 10_000;
          if (prefix === 'communities/1/') {
            return {
              entries: objects.map((key) => ({ key, uploaded: new Date(0) })),
              truncated: false,
            };
          }
          return { entries: [], truncated: false };
        },
      };
      const store = {
        list: async () => records,
        write: async (r: ErasureRecord) => {
          records[0] = r;
        },
      };
      const service = new CommunityErasureService(
        repo,
        storage,
        store,
        () => new Date(clockMs)
      );
      // Even if a caller passes a D1 budget alongside 'free' and a slow clock,
      // Free imposes neither D1 budget nor wall-clock deadline cutoffs.
      await service.sweep(
        new Date(0),
        workerErasureStorageBudget('free'),
        5,
        'free'
      );
      expect(legacyFiles).toEqual([]);
      expect(deleteMany).toHaveBeenCalledWith([
        'communities/1/media/photo.png',
      ]);
      expect(objects).toEqual([]);

      // Second pass sees empty R2 listing and completes despite slow clock.
      await service.sweep(
        new Date(60_000),
        workerErasureStorageBudget('free'),
        workerErasureD1Budget('free'),
        'free'
      );
      expect(erased).toEqual([1]);
      expect(records[0]!.outcome).toBe('completed');
    });

    it('stops Paid erasure before deleteMany when R2 listing pushes past ERASURE_PASS_MAX_WALL_MS', async () => {
      let clockMs = 1_000;
      const erased: number[] = [];
      const records: ErasureRecord[] = [
        {
          communityId: 1,
          requestId: 'req-paid-list-timeout',
          requestingActorId: null,
          requestedAt: new Date(0).toISOString(),
          completedAt: null,
          outcome: 'pending',
        },
      ];
      const repo = {
        activateDueErasures: async () => true,
        erasureWork: async () => [],
        erasureUploads: async () => [],
        erasureArchiveCustody: async () => null,
        erasureLegacyFiles: async () => [],
        eraseRows: async (id: number) => {
          erased.push(id);
        },
      } as unknown as CommunitySovereigntyRepository;
      const deleteMany = vi.fn(async () => {});
      const storage: FoundationStorage = {
        read: async () => null,
        delete: async () => {},
        deleteMany,
        fenceCommunity: async () => {},
        list: async () => {
          clockMs += ERASURE_PASS_MAX_WALL_MS;
          return {
            entries: [
              { key: 'communities/1/media/photo.png', uploaded: new Date(0) },
            ],
            truncated: false,
          };
        },
      };
      const store = {
        list: async () => records,
        write: async (r: ErasureRecord) => {
          records[0] = r;
        },
      };
      const service = new CommunityErasureService(
        repo,
        storage,
        store,
        () => new Date(clockMs)
      );
      await service.sweep(
        new Date(0),
        workerErasureStorageBudget('paid'),
        undefined,
        'paid'
      );
      expect(deleteMany).not.toHaveBeenCalled();
      expect(erased).toEqual([]);
      expect(records[0]!.completedAt).toBeNull();
    });

    it('logs one content-free warning in scheduled() on invalid WORKERS_PLAN and falls back to free', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const worker = createWorker();
        const statement = {
          bind: () => statement,
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true, meta: {} }),
          raw: async () => [],
        };
        const db = {
          prepare: () => statement,
          batch: async () => [],
          withSession: () => db,
        };
        const media = {
          list: async () => ({ objects: [], truncated: false }),
          get: async () => null,
          put: async () => null,
          head: async () => null,
          delete: async () => {},
        };
        const env = {
          WORKERS_PLAN: 'secret-invalid-plan-value',
          DB: db,
          MEDIA: media,
        } as unknown as WorkerBindings;
        const pending: Promise<unknown>[] = [];
        const ctx = {
          waitUntil: (p: Promise<unknown>) => pending.push(p),
          passThroughOnException: () => {},
        } as unknown as ExecutionContext;
        const controller = {
          cron: '*/1 * * * *',
          scheduledTime: 1_000,
          noRetry: () => {},
        } as unknown as ScheduledController;

        await worker.scheduled(controller, env, ctx);
        await worker.scheduled(controller, env, ctx);
        await Promise.all(pending);

        expect(errorSpy).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          'secret-invalid-plan-value'
        );
      } finally {
        warn.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
