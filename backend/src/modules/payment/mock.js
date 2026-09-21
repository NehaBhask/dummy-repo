// Mock payment gateway. It exists to prove the transactional flow, not to move money.
// It is only ever called OUTSIDE a database transaction (design: no I/O inside a locked txn), so
// a slow or failing gateway can never hold up other requests waiting on the same inventory row.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ bookingId: string, amount: string, currency: string, method: string, simulate?: string }} req
 * @returns {Promise<{ ok: true, gateway_reference: string } | { ok: false, failure_code: string }>}
 */
export async function authoriseAndCapture({ bookingId, simulate }) {
  await sleep(5 + Math.random() * 10); // gateway latency
  if (simulate === 'payment') {
    // payments.failure_code is a closed enum with no "declined"; over_budget is the closest fit.
    return { ok: false, failure_code: 'over_budget' };
  }
  return { ok: true, gateway_reference: `mock_${bookingId.slice(4)}` };
}
