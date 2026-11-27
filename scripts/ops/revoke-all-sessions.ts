/**
 * Source-checkout wrapper for the emergency global session revocation
 * (#137). The implementation lives in src/ops so it is compiled into the
 * production image (node dist/ops/revoke-all-sessions.js).
 *
 *   npx tsx scripts/ops/revoke-all-sessions.ts            # dry run
 *   npx tsx scripts/ops/revoke-all-sessions.ts --confirm  # revoke
 */
import { main } from '../../src/ops/revoke-all-sessions.js';

process.exit(await main(process.argv.slice(2)));
