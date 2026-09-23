import { closePool } from '../src/db.js';
import { checkInvariants } from '../src/modules/invariants.js';

try {
  const r = await checkInvariants();
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
} finally {
  await closePool();
}
