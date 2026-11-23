import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { authenticatedMedia } from '../../../scripts/walkthrough/chapters/target-check.js';
import {
  listAll,
  newState,
  offsetOfMatch,
  type Config,
  type Ctx,
} from '../../../scripts/walkthrough/context.js';
import { Walk } from '../../../scripts/walkthrough/walk.js';

// An API error in a paged read must fail loudly, never look like "no more rows".
async function withBrokenApi<T>(
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'boom', code: 'internal_error' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await run(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('paged reads never hide API errors', () => {
  it('authenticatedMedia records a failed step and throws on a non-2xx story list', async () => {
    await withBrokenApi(async (baseUrl) => {
      const w = new Walk(baseUrl, { quiet: true });
      const ctx: Ctx = {
        w,
        cfg: {} as Config,
        s: newState(),
      };
      w.chapter('Check', 'check');
      const admin = w.actor('Real admin', 'community admin');
      await expect(authenticatedMedia(ctx, admin)).rejects.toThrow(/500/);
      const failed = w.records.filter((r) => r.outcome === 'fail');
      expect(failed).toHaveLength(1);
      expect(failed[0]!.status).toBe(500);
      expect(ctx.s.targetCounts.admin_media).toBeUndefined();
    });
  });

  it('listAll and offsetOfMatch throw with status and code', async () => {
    await withBrokenApi(async (baseUrl) => {
      const w = new Walk(baseUrl, { quiet: true });
      w.chapter('Check', 'check');
      const actor = w.actor('Ana', 'admin');
      await expect(listAll(actor, '/v2/stories', () => [])).rejects.toThrow(
        /got 500 \(internal_error\)/
      );
      await expect(
        offsetOfMatch(
          actor,
          '/v2/stories',
          () => [],
          () => true
        )
      ).rejects.toThrow(/got 500/);
    });
  });
});
