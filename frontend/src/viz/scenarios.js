// Scripted timelines for the simulated event source. `at` is a position on a 0–100 animation clock.
// Signals: blue = processing, amber = waiting, green = succeeded, red = rejected, grey = closed.
export const SCENARIOS = ['race', 'saga', 'retry'];
export const DOTS = { race: 8, saga: 3, retry: 2 };
export const SIM_FREE = 3;

export const timelines = {
  race: [
    { at: 0, signal: 'blue', message: '8 requests received', payload: { op: 'reserve', inventory_id: 'inv_demo_jaipur', units: 1, free: 3 } },
    { at: 18, signal: 'amber', message: 'Requests queued at the row lock', payload: { op: 'lock_wait', queue_depth: 7 } },
    { at: 35, signal: 'green', message: 'Reservation committed · 2 free', payload: { op: 'reserve', result: 'granted', remaining: 2 } },
    { at: 52, signal: 'green', message: 'Reservation committed · 1 free', payload: { op: 'reserve', result: 'granted', remaining: 1 } },
    { at: 68, signal: 'green', message: 'Reservation committed · 0 free', payload: { op: 'reserve', result: 'granted', remaining: 0 } },
    { at: 82, signal: 'red', message: 'Remaining requests rejected', payload: { op: 'reserve', result: 'sold_out', rejected: 5 } },
  ],
  saga: [
    { at: 0, signal: 'blue', message: 'Multi-item booking started', payload: { op: 'saga_start', items: 2 } },
    { at: 20, signal: 'blue', message: 'Hotel and flight held together · one deadline', payload: { op: 'reserve_trip', result: 'held', shared_deadline: true } },
    { at: 42, signal: 'green', message: 'Hotel line confirmed', payload: { op: 'confirm_line', line: 'hotel', result: 'confirmed' } },
    { at: 60, signal: 'red', message: 'Flight line failed', payload: { op: 'confirm_line', line: 'flight', result: 'failed', code: 'sold_out' } },
    { at: 76, signal: 'amber', message: 'Compensating prior steps', payload: { op: 'compensate', line: 'hotel', refund: 'not_captured' } },
    { at: 92, signal: 'grey', message: 'Saga closed safely', payload: { op: 'saga_complete', result: 'compensated' } },
  ],
  retry: [
    { at: 0, signal: 'blue', message: 'Duplicate keys received', payload: { op: 'confirm', idempotency_key: 'book_7K2P', attempts: 2 } },
    { at: 28, signal: 'amber', message: 'Both requests converge at the idempotency key', payload: { op: 'lock_wait', idempotency_key: 'book_7K2P' } },
    { at: 55, signal: 'green', message: 'First request committed', payload: { op: 'confirm', result: 'granted', booking_id: 'bkg_901' } },
    { at: 72, signal: 'green', message: 'Stored result replayed', payload: { op: 'confirm', result: 'same_booking', booking_id: 'bkg_901', replayed: true } },
  ],
};
