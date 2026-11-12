import { compare } from 'bcryptjs';
import type { PasswordVerifier } from './services/hono-foundation.service.js';

/** Node launch-source verifier; Workers auth is selected after #194 measurements. */
export const nodePasswordVerifier: PasswordVerifier = {
  async verify(password, encodedHash) {
    const supported = /^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/.test(
      encodedHash
    );
    const dummy =
      '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';
    try {
      return (
        (await compare(password, supported ? encodedHash : dummy)) && supported
      );
    } catch {
      return false;
    }
  },
};
