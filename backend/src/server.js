import http from 'node:http';
import { config } from './config.js';
import { pool } from './db.js';
import { createApp } from './app.js';
import { startExpiryWorker } from './workers/expiry.js';

/** Start the API. `port: 0` picks a free port (used by tests). Returns handles for shutdown. */
export async function startServer({ port = config.port, worker: workerOn = config.expiryWorkerEnabled } = {}) {
  const worker = workerOn ? startExpiryWorker({ intervalMs: config.expiryIntervalMs }) : null;
  const app = createApp({ worker });

  // Node's default accept backlog is 511; a 500-way race opens that many sockets in the same
  // instant, and anything beyond the backlog is refused at the TCP level before Express sees it.
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen({ port, backlog: 2048 }, () => resolve(s));
  });
  const actual = server.address().port;
  app.locals.baseUrl = `http://127.0.0.1:${actual}`;

  return {
    app,
    server,
    port: actual,
    baseUrl: app.locals.baseUrl,
    worker,
    async close() {
      worker?.stop();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
    },
  };
}

export async function shutdown(handle) {
  await handle.close();
  await pool.end();
}
