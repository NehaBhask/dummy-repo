// Thin client for the backend REST API. Every call carries the UI language so server-side error
// messages come back localised, and failures become ApiError with the stable `code`.
let currentLang = 'en';
export const setApiLang = (l) => {
  currentLang = l;
};

export class ApiError extends Error {
  constructor(status, body) {
    const e = body?.error;
    super(e?.message || `Request failed (${status})`);
    this.status = status;
    this.code = e?.code ?? (status === 0 ? 'network' : 'error');
    this.details = e?.details;
    this.body = body; // for a rolled-back booking this still contains the compensated booking
  }
}

async function request(method, path, { body, headers, query } = {}) {
  const qs = query
    ? '?' +
      new URLSearchParams(
        Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false),
      ).toString()
    : '';
  let res;
  try {
    res = await fetch(path + qs, {
      method,
      headers: { 'content-type': 'application/json', 'accept-language': currentLang, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: { code: 'network', message: 'Cannot reach the server' } });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return { data, status: res.status, replayed: res.headers.get('idempotent-replayed') === 'true' };
}

const get = async (path, query) => (await request('GET', path, { query })).data;

// Idempotency keys must be stable across retries of the SAME action and fresh for each new one.
export const newKey = (prefix) => `${prefix}_${crypto.randomUUID()}`;

export const api = {
  meta: () => get('/api/meta'),
  cities: () => get('/api/cities'),
  currencies: () => get('/api/currencies'),
  searchHotels: (q) => get('/api/search/hotels', q),
  aiSearch: async (query, currency) => (await request('POST', '/api/search/ai', { body: { query, currency } })).data,
  routes: (q) => get('/api/flights/routes', q),
  searchFlights: (q) => get('/api/search/flights', q),

  createHold: async ({ items, key, ttl }) =>
    request('POST', '/api/holds', { body: { items, ttl_seconds: ttl || undefined }, headers: { 'idempotency-key': key } }),
  getHold: (id) => get(`/api/holds/${id}`),
  releaseHold: async (id) => (await request('POST', `/api/holds/${id}/release`, { body: {} })).data,

  confirm: ({ key, body }) => request('POST', '/api/bookings', { body, headers: { 'idempotency-key': key } }),
  bookings: (status) => get('/api/bookings', { status }),
  booking: (id) => get(`/api/bookings/${id}`),
  cancel: async (id) => (await request('POST', `/api/bookings/${id}/cancel`, { body: {} })).data,

  contended: () => get('/api/inventory/contended', { limit: 30 }),
  startLoadTest: async (body) => (await request('POST', '/api/loadtests', { body })).data,
  getRun: (id) => get(`/api/loadtests/${id}`),
  runs: () => get('/api/loadtests', { limit: 10 }),
  invariants: () => get('/api/invariants'),
};
