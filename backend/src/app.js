import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { AppError, fromPgError, localise, pickLang } from './errors.js';
import { buildRouter } from './routes.js';

export function createApp({ worker } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin, exposedHeaders: ['Idempotent-Replayed'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use((req, _res, next) => {
    req.lang = pickLang(req);
    next();
  });

  const router = buildRouter({ worker });
  app.use('/api', router);
  app.get('/health', (_req, res) => res.redirect(307, '/api/health'));

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
