// Error model. `code` is stable and machine-readable (it reuses the error_code enum from
// data-model/enums.json where one fits); `message` is localised (en / hi).

const CATALOGUE = {
  validation_error: {
    status: 400,
    en: 'The request is invalid.',
    hi: 'अनुरोध में मान्य जानकारी नहीं है।',
  },
  invalid_id: {
    status: 404,
    en: 'The requested record does not exist.',
    hi: 'अनुरोधित रिकॉर्ड नहीं मिला।',
  },
  forbidden: {
    status: 403,
    en: 'You do not have access to this resource.',
    hi: 'आपको इस संसाधन तक पहुँच की अनुमति नहीं है।',
  },
  sold_out: {
    status: 409,
    en: 'Sorry, that inventory is no longer available.',
    hi: 'क्षमा करें, यह इन्वेंटरी अब उपलब्ध नहीं है।',
  },
  hold_expired: {
    status: 409,
    en: 'The hold has expired or was released. Please search again.',
    hi: 'होल्ड की समय-सीमा समाप्त हो गई है। कृपया फिर से खोजें।',
  },
  idempotency_conflict: {
    status: 422,
    en: 'This idempotency key was already used for a different request.',
    hi: 'यह आइडेम्पोटेंसी कुंजी पहले किसी अन्य अनुरोध के लिए उपयोग की जा चुकी है।',
  },
  request_in_progress: {
    status: 409,
    en: 'This request is already being processed. Retry shortly.',
    hi: 'यह अनुरोध पहले से प्रक्रिया में है। कृपया कुछ क्षण बाद पुनः प्रयास करें।',
  },
  invalid_state: {
    status: 409,
    en: 'This action is not possible in the record’s current state.',
    hi: 'वर्तमान स्थिति में यह कार्रवाई संभव नहीं है।',
  },
  constraint_infeasible: {
    status: 422,
    en: 'The requested stay violates the property’s booking rules.',
    hi: 'अनुरोधित ठहराव संपत्ति के बुकिंग नियमों के अनुरूप नहीं है।',
  },
  currency_mismatch: {
    status: 422,
    en: 'The currencies involved do not match.',
    hi: 'संबंधित मुद्राएँ मेल नहीं खातीं।',
  },
  over_budget: {
    status: 402,
    en: 'Payment was declined. The booking was rolled back and inventory restored.',
    hi: 'भुगतान अस्वीकृत हुआ। बुकिंग रद्द कर दी गई और इन्वेंटरी वापस कर दी गई।',
  },
  booking_failed: {
    status: 409,
    en: 'The booking could not be completed and was rolled back.',
    hi: 'बुकिंग पूरी नहीं हो सकी और उसे वापस ले लिया गया।',
  },
  compensation_incomplete: {
    status: 500,
    en: 'The booking failed and automatic rollback is incomplete. Support has been flagged.',
    hi: 'बुकिंग विफल रही और स्वचालित रोलबैक अधूरा है। सहायता टीम को सूचित किया गया है।',
  },
  contention_timeout: {
    status: 503,
    en: 'The system is busy. Please retry.',
    hi: 'सिस्टम अभी व्यस्त है। कृपया पुनः प्रयास करें।',
  },
  ai_unavailable: {
    status: 503,
    en: 'AI search is unavailable. Use the structured search instead.',
    hi: 'एआई खोज उपलब्ध नहीं है। कृपया सामान्य खोज का उपयोग करें।',
  },
  not_found: {
    status: 404,
    en: 'Route not found.',
    hi: 'मार्ग नहीं मिला।',
  },
  internal_error: {
    status: 500,
    en: 'Something went wrong. Please try again later.',
    hi: 'कुछ गलत हो गया। कृपया बाद में पुनः प्रयास करें।',
  },
};

// Counts how often the database's CHECK (booked+held<=total) had to reject a write. Application
// logic is supposed to make that unreachable, so a correct system leaves this at 0; the load test
// and the tests assert exactly that, which is stronger than only checking the final counts.
export const metrics = { safetyNetHits: 0 };

export class AppError extends Error {
  constructor(code, { details, status, message } = {}) {
    super(message ?? CATALOGUE[code]?.en ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? CATALOGUE[code]?.status ?? 500;
    this.details = details;
  }
}

export const statusOf = (code) => CATALOGUE[code]?.status ?? 409;

export const localise = (code, lang) => CATALOGUE[code]?.[lang] ?? CATALOGUE[code]?.en ?? code;

export function pickLang(req) {
  const q = String(req.query?.lang ?? '').toLowerCase();
  if (q === 'hi' || q === 'en') return q;
  const h = String(req.headers['accept-language'] ?? '').toLowerCase();
  return h.startsWith('hi') ? 'hi' : 'en';
}

// Node-postgres' own pool-queue timeout is a plain client-side Error with no SQLSTATE .code
// (verified: { code: undefined, message: 'timeout exceeded when trying to connect' }) — it would
// otherwise fall through as an unrecognised error and surface as a bare 500. Under genuine
// system-wide overload (every pooled connection busy, not just one contended row) this is the
// failure mode that actually matters: callers should get the same fast, clear "busy, retry" the
// row-lock-timeout case already gives, not a generic error.
const POOL_TIMEOUT_MESSAGE = /timeout exceeded when trying to connect/i;

// Translate low-level Postgres/pg-client errors into API errors. Anything unrecognised is returned as-is.
export function fromPgError(err) {
  switch (err?.code) {
    case '55P03': // lock_not_available (lock_timeout)
    case '40P01': // deadlock_detected (after withTx exhausted its retries)
    case '40001': // serialization_failure
      return new AppError('contention_timeout', { details: { pg: err.code } });
    case '23503': // foreign key violation — an id we were given doesn't exist
      return new AppError('invalid_id', { details: { constraint: err.constraint } });
    case '23514': // CHECK violation — the DB safety net (booked+held<=total) fired
      metrics.safetyNetHits++;
      console.error('[SAFETY NET] CHECK constraint rejected a write:', err.constraint, err.detail);
      return new AppError('sold_out', { details: { constraint: err.constraint } });
    case 'ECONNREFUSED': // Postgres itself unreachable/down
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
      return new AppError('contention_timeout', { details: { reason: 'database unreachable', code: err.code } });
    default:
      if (err instanceof Error && POOL_TIMEOUT_MESSAGE.test(err.message ?? '')) {
        return new AppError('contention_timeout', { details: { reason: 'connection pool exhausted' } });
      }
      return err;
  }
}
