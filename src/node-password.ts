import { compare } from 'bcrypt';
import type { PasswordVerifier } from './services/hono-foundation.service.js';

export const nodePasswordVerifier: PasswordVerifier = {
  async verify(password, hash) {
    const match = /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/.exec(hash);
    const dummy = 'N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    try {
      // Every rejection executes costs 04..14 in order, substituting the real
      // hash only at its cost. Dummy matches cannot authenticate an account.
      for (let cost = 4; cost <= 14; cost++) {
        const real = match !== null && Number(match[1]) === cost;
        const candidate = real
          ? hash.replace(/^\$2y\$/, '$2b$')
          : `$2b$${String(cost).padStart(2, '0')}$${dummy}`;
        if ((await compare(password, candidate)) && real) return true;
      }
      return false;
    } catch {
      return false;
    }
  },
};
