import { config } from './config.js';
import { startServer, shutdown } from './server.js';

const handle = await startServer();
console.log(
  `kognivera backend listening on ${handle.baseUrl}  (db pool max ${config.poolMax}, ` +
    `expiry worker ${handle.worker ? `every ${config.expiryIntervalMs / 1000}s` : 'off'})`,
);

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`\n${sig} received, shutting down…`);
    await shutdown(handle);
    process.exit(0);
  });
}
