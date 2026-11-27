// Test-only preload for the real Node entrypoint: once the file named by
// SLOW_ARM_FILE exists, the next
// sovereignty step (run by the request middleware) logs entry, stalls 1.5 s,
// then logs completion. Lets a test hold a real handler in flight.
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';
import { CommunitySovereigntyRepository } from '../../../src/repositories/community-sovereignty.repository.js';

// Arm only inside the request path /x (not for maintenance sweeps).
const requestUrl = new AsyncLocalStorage<string | undefined>();
const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function emit(
  this: http.Server,
  event: string | symbol,
  ...args: unknown[]
) {
  if (event === 'request') {
    const req = args[0] as http.IncomingMessage;
    return requestUrl.run(req.url, () =>
      Reflect.apply(originalEmit, this, [event, ...args])
    );
  }
  return Reflect.apply(originalEmit, this, [event, ...args]);
} as typeof originalEmit;
const armFile = process.env.SLOW_ARM_FILE ?? '';
const original = CommunitySovereigntyRepository.prototype.applyDueWithdrawals;
CommunitySovereigntyRepository.prototype.applyDueWithdrawals =
  async function patched(this: CommunitySovereigntyRepository, ...args) {
    if (requestUrl.getStore() === '/x' && armFile && existsSync(armFile)) {
      unlinkSync(armFile);
      console.error('slow handler entered');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const result = await original.apply(this, args);
      console.error('slow handler done');
      return result;
    }
    return original.apply(this, args);
  };
