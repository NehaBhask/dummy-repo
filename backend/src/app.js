import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError, fromPgError, localise, pickLang } from './errors.js';
import { buildRouter } from './routes.js';
import { attachSession } from './modules/session.js';

export function createApp({ worker } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Skippable under load tests (LOG_REQUESTS=off) so a 500-way race doesn't flood the terminal.
  if (config.env !== 'test' && process.env.LOG_REQUESTS !== 'off') app.use(morgan('dev'));
  app.use(cors({ origin: config.corsOrigin, exposedHeaders: ['Idempotent-Replayed'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, _res, next) => {
    req.lang = pickLang(req);
    next();
  });

  const router = buildRouter({ worker });
  app.use('/api', attachSession, router);
  app.get('/health', (_req, res) => res.redirect(307, '/api/health'));

  // Serve the built web app (frontend/dist) from the same server, so `npm start` is the whole product.
  // Any non-API GET falls back to index.html (client-side routing).
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend/dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { maxAge: '1h', index: false }));
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use((req, _res, next) => next(new AppError('not_found', { details: { path: req.path } })));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let e = err;
    if (e instanceof ZodError) e = new AppError('validation_error', { details: e.issues.map((i) => i.message) });
    else if (e?.type === 'entity.parse.failed') e = new AppError('validation_error', { details: { body: 'malformed JSON' } });
    else if (!(e instanceof AppError)) e = fromPgError(e);

    if (!(e instanceof AppError)) {
      console.error('[error]', req.method, req.originalUrl, err);
      e = new AppError('internal_error');
    } else if (e.status >= 500) {
      console.error('[error]', req.method, req.originalUrl, e.code, e.details ?? '');
    }
    if (e.code === 'contention_timeout') res.set('Retry-After', '1');
    if (e.code === 'request_in_progress') res.set('Retry-After', '1');

    res.status(e.status).json({
      error: { code: e.code, message: localise(e.code, req.lang), ...(e.details ? { details: e.details } : {}) },
    });
  });

  return app;
}
