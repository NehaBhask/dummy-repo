import { expireHolds } from '../modules/booking/holds.js';

/**
 * Releases expired holds on a fixed cadence. Runs in-process; expireHolds() takes a Postgres
 * advisory lock, so a second instance skips its turn instead of double-processing.
 * A hold past its deadline is already dead to confirmBooking() — the worker only returns its
 * units to the pool, so a late sweep is a capacity delay, never a correctness problem.
 */
export function startExpiryWorker({ intervalMs, log = console.log }) {
  const state = { running: false, last_run_at: null, last_expired: 0, total_expired: 0, last_error: null };

  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      let expired = 0;
      for (let i = 0; i < 20; i++) {
        const r = await expireHolds({ batchSize: 500 });
        expired += r.expired;
        if (r.skipped || r.expired < 500) break;
      }
      state.last_expired = expired;
      state.total_expired += expired;
      state.last_error = null;
      if (expired) log(`[expiry] released ${expired} expired hold(s)`);
    } catch (err) {
      state.last_error = err.message;
      console.error('[expiry] sweep failed:', err.message);
    } finally {
      state.running = false;
      state.last_run_at = new Date().toISOString();
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return { state, tick, stop: () => clearInterval(timer) };
}
