import { compare } from 'bcrypt';
import type { PasswordVerifier } from './services/hono-foundation.service.js';

/** Native Node verifier; Workers auth is selected after #194 measurements. */
export const nodePasswordVerifier: PasswordVerifier = {
  async verify(password, hash) {
    const pattern = /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/;
    const supported = pattern.test(hash);
    const dummy =
      '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    try {
      const candidate = supported ? hash.replace(/^\$2y\$/, '$2b$') : dummy;
      return (await compare(password, candidate)) && supported;
    } catch {
      return false;
    }
  },
};
