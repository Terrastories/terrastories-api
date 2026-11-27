// Test-only preload for the real Node entrypoint: once the file named by
// SLOW_ARM_FILE exists, the next
// sovereignty step (run by the request middleware) logs entry, stalls 1.5 s,
// then logs completion. Lets a test hold a real handler in flight.
import { existsSync, unlinkSync } from 'node:fs';
import { CommunitySovereigntyRepository } from '../../../src/repositories/community-sovereignty.repository.js';

const armFile = process.env.SLOW_ARM_FILE ?? '';
const original = CommunitySovereigntyRepository.prototype.applyDueWithdrawals;
CommunitySovereigntyRepository.prototype.applyDueWithdrawals =
  async function patched(this: CommunitySovereigntyRepository, ...args) {
    if (armFile && existsSync(armFile)) {
      unlinkSync(armFile);
      console.error('slow handler entered');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const result = await original.apply(this, args);
      console.error('slow handler done');
      return result;
    }
    return original.apply(this, args);
  };
