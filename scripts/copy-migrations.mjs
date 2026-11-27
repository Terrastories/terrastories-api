// Copy the bundled SQL migrations and drizzle journals next to the compiled
// output, so dist/db/migrations exists for `npm run start:hono` (the startup
// check and db:migrate resolve migrations relative to the running file).
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const source = 'src/db/migrations';
const target = path.join(process.argv[2] ?? 'dist', 'db', 'migrations');
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
