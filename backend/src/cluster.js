import cluster from 'node:cluster';
import os from 'node:os';

/*
 * Multi-process entry: the primary process accepts connections and hands them round-robin to N
 * worker processes, each running the normal server (src/index.js). One Node process tops out at
 * a few hundred requests/s; several use several cores.
 *
 * Safe because correctness lives in Postgres, not in process memory: row locks serialise
 * contenders across processes, idempotency is a unique index, and the expiry worker takes an
 * advisory lock so only one process sweeps at a time.
 *
 * Mind the connection budget: every worker has its own pool (PG_POOL_MAX, default 20), and
 * Postgres allows 100 connections by default. WEB_CONCURRENCY × PG_POOL_MAX must stay below that.
 */
const workers = Number(process.env.WEB_CONCURRENCY) || Math.min(4, os.availableParallelism());

if (cluster.isPrimary) {
  // Windows defaults to letting the OS hand connections to whichever worker asks first, which is
  // very uneven; force real round-robin.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  let stopping = false;

  console.log(`primary ${process.pid}: starting ${workers} worker(s) (round-robin)`);
  for (let i = 0; i < workers; i++) cluster.fork();

  cluster.on('exit', (w, code, signal) => {
    if (stopping) return;
    console.error(`worker ${w.process.pid} exited (${signal ?? code}); restarting`);
    cluster.fork();
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const w of Object.values(cluster.workers)) w?.kill();
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  await import('./index.js');
}
