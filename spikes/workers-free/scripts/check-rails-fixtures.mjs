// Recomputes each bcrypt-ruby 3.1.20 hash with bcryptjs from (password, stored salt) and
// requires the full encoded string to match byte for byte, as the client-side bcrypt step
// of the auth design would. Also checks that bytes past 72 are ignored, as in Rails.
// Usage: node scripts/check-rails-fixtures.mjs > results/rails-bcrypt-check.json
import { readFileSync } from 'node:fs';
import bcrypt from 'bcryptjs';

const { bcryptRuby, fixtures } = JSON.parse(
  readFileSync(
    new URL('../results/rails-bcrypt-fixtures.json', import.meta.url),
    'utf8'
  )
);
const rows = fixtures.map(({ cost, password, hash }) => {
  const salt = hash.slice(0, 29);
  const recomputed = bcrypt.hashSync(password, salt);
  return {
    cost,
    passwordBytes: Buffer.byteLength(password),
    prefix: hash.slice(0, 4),
    exactMatch: recomputed === hash,
    compareSync: bcrypt.compareSync(password, hash),
    wrongPasswordRejected:
      !bcrypt.compareSync(password + 'x', hash) ||
      Buffer.byteLength(password) >= 72,
  };
});
// Truncation parity: the 72-byte and 72+suffix fixtures share a cost and must verify each other.
const a72 = fixtures.find(
  (f) => f.cost === 10 && f.password === 'a'.repeat(72)
);
const truncationParity = bcrypt.compareSync(
  'a'.repeat(72) + 'anything',
  a72.hash
);
const pass =
  rows.every((r) => r.exactMatch && r.compareSync && r.wrongPasswordRejected) &&
  truncationParity;
console.log(
  JSON.stringify(
    {
      bcryptRuby,
      bcryptjs: '3.0.3',
      n: rows.length,
      pass,
      truncationParity,
      rows,
    },
    null,
    2
  )
);

if (!pass) process.exitCode = 1;
