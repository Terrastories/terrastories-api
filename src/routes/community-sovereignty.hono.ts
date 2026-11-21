import type { CommunityErasureService } from '../services/community-erasure.service.js';
import {
  redactErasureActor,
  type ErasureRecordStore,
} from '../services/erasure-record-store.js';
/**
 * Hono routes for Slice 13b community sovereignty endpoints
 * (SPEC-V2 §6.2, §6.8, §7 #187; route registry §9).
 *
 * Mounted after the `/v2/*` session gate in `src/hono-app.ts`:
 * - `GET /v2/community/sovereignty`
 * - `PUT /v2/community/steward`
 */

import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie } from 'hono/cookie';
import type { HonoAuthRepository } from '../repositories/hono-auth.repository.js';
import type { CommunitySovereigntyRepository } from '../repositories/community-sovereignty.repository.js';
import { CommunitySovereigntyService } from '../services/community-sovereignty.service.js';
import { tokenDigest } from '../services/hono-foundation.service.js';
import { actorOf, parseJsonRequestBody } from './community-writes.hono.js';

export interface CommunitySovereigntyRoutesOptions {
  repository: CommunitySovereigntyRepository;
  authRepository: HonoAuthRepository;
  serverSecret?: string;
  erasureStore?: ErasureRecordStore;
  erasureService?: CommunityErasureService;
  ipFor: (c: Context) => string;
  now: () => Date;
}

const sovereigntyBody4k = bodyLimit({
  maxSize: 4096,
  onError: (c) => c.json({ error: 'Request too large' }, 413),
});

export function registerCommunitySovereigntyRoutes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app: Hono<any>,
  options: CommunitySovereigntyRoutesOptions
): void {
  const service = new CommunitySovereigntyService(
    options.repository,
    options.authRepository,
    options.serverSecret,
    options.erasureStore
  );

  app.get('/v2/admin/erasures', async (c) => {
    if (actorOf(c).role !== 'super_admin' || actorOf(c).communityId !== null)
      return c.json({ error: 'Forbidden' }, 403);
    if (!options.erasureStore)
      return c.json({ error: 'Service unavailable' }, 503);
    const records = await options.erasureStore.list();
    const data = [];
    for (const record of records) {
      const redacted = redactErasureActor(record, options.now());
      if (redacted.requestingActorId !== record.requestingActorId)
        await options.erasureStore.write(redacted);
      data.push(redacted);
    }
    return c.json({ data }, 200);
  });

  app.get('/v2/community/sovereignty', async (c) => {
    const result = await service.getSovereignty(actorOf(c));
    return c.json(result.body, result.status);
  });

  app.put('/v2/community/steward', sovereigntyBody4k, async (c) => {
    const parsed = await parseJsonRequestBody(c);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, parsed.status);
    }
    const rawSession = getCookie(c, 'ts_session');
    const sessionTokenHash = rawSession
      ? await tokenDigest(rawSession)
      : undefined;
    const result = await service.updateSteward(
      actorOf(c),
      parsed.body,
      sessionTokenHash,
      {
        clientIp: options.ipFor(c),
        now: options.now(),
        userAgent: c.req.header('user-agent'),
      }
    );
    return c.json(result.body, result.status);
  });
  for (const [path, action] of [
    ['/v2/community/erasure', service.erase.bind(service)],
    ['/v2/community/withdrawal', service.withdraw.bind(service)],
    ['/v2/community/sovereignty/cancel', service.cancel.bind(service)],
  ] as const) {
    app.post(path, sovereigntyBody4k, async (c) => {
      const parsed = await parseJsonRequestBody(c);
      if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
      const rawSession = getCookie(c, 'ts_session');
      const result = await action(
        actorOf(c),
        parsed.body,
        rawSession ? await tokenDigest(rawSession) : undefined,
        {
          clientIp: options.ipFor(c),
          now: options.now(),
          userAgent: c.req.header('user-agent'),
        }
      );
      if (
        path === '/v2/community/erasure' &&
        result.status === 202 &&
        options.erasureService
      ) {
        try {
          await options.erasureService.sweep(options.now());
        } catch {
          // eslint-disable-next-line no-console -- content-free retry signal
          console.warn('maintenance: erasure pending retry');
        }
      }
      return c.json(result.body, result.status);
    });
  }
}
