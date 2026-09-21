import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : d;
};

const env = process.env.NODE_ENV ?? 'development';

export const config = {
  env,
  port: int(process.env.PORT, 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/kognivera',
  poolMax: int(process.env.PG_POOL_MAX, 20),
  lockTimeoutMs: int(process.env.LOCK_TIMEOUT_MS, 2000),

  holdTtlSeconds: int(process.env.HOLD_TTL_SECONDS, 600),
  holdTtlMinSeconds: 5,
  holdTtlMaxSeconds: 1800,
  expiryIntervalMs: int(process.env.EXPIRY_INTERVAL_MS, 30_000),
  expiryWorkerEnabled: process.env.EXPIRY_WORKER !== 'off',

  // Reject visibly sold-out requests without taking the row lock (set FAST_REJECT=off to compare).
  fastReject: process.env.FAST_REJECT !== 'off',
  // How long a 'this row is full' answer is remembered in-process (staleness bound for units freed
  // by another process; this process clears it immediately when it frees units itself).
  soldOutCacheMs: Number.parseInt(process.env.SOLD_OUT_CACHE_MS ?? '300', 10),

  // 'sql' = reserve inside one Postgres function call (lock held for microseconds);
  // 'js'  = the same logic as a multi-round-trip transaction from Node (kept for comparison).
  holdImpl: process.env.HOLD_IMPL === 'js' ? 'js' : 'sql',

  demoUserId: process.env.DEMO_USER_ID || null,
  faultInjection: (process.env.ALLOW_FAULT_INJECTION ?? String(env !== 'production')) === 'true',

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || null,
    // gemini-2.5-flash is closed to new API users. Full "flash" models think before answering (6-19 s
    // measured); the lite models answered the demo queries correctly in 1-3 s. Tried in order.
    models: [
      process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
      ...(process.env.GEMINI_FALLBACK_MODELS ?? 'gemini-flash-lite-latest,gemini-3.1-flash-lite')
        .split(',').map((m) => m.trim()).filter(Boolean),
    ],
  },
  loadTestBaseUrl: process.env.LOADTEST_BASE_URL || null,
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
