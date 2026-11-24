import express, { Router } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import './types.js';
import { API_ROOT, config } from './config.js';
import { authenticate, terminalMiddleware } from './auth.js';
import { errorHandler, notFound } from './errors.js';
import { idempotency } from './idempotency.js';
import { sseHandler } from './events.js';
import { pool } from './db.js';
import { requireBusiness, resolveTenant } from './tenant.js';
import { router as signupRoutes, businessInfo } from './routes/signup.js';
import { router as platformRoutes } from './routes/platform.js';
import { router as authRoutes } from './routes/auth.js';
import { router as cardRoutes } from './routes/cards.js';
import { router as customerRoutes } from './routes/customers.js';
import { router as historyRoutes } from './routes/history.js';
import { router as dashboardRoutes } from './routes/dashboard.js';
import { router as adminRoutes } from './routes/admin.js';
import { router as dataRoutes } from './routes/data.js';
import { router as kioskRoutes, kioskLimiter } from './routes/kiosk.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Terminal-Key', 'X-Approval-Token', 'X-Business'],
      exposedHeaders: ['Idempotent-Replay', 'Content-Disposition', 'X-Checksum-SHA256', 'RateLimit', 'RateLimit-Policy'],
    }),
  );
  app.use(express.json({ limit: '12mb' }));

  app.get('/health', async (_req, res) => {
    const r = await pool.query('SELECT 1 AS ok');
    res.json({ ok: r.rows[0].ok === 1, version: config.version, time: new Date().toISOString() });
  });

  const specPath = path.join(API_ROOT, 'openapi.yaml');
  app.get('/api/v1/openapi.yaml', (_req, res) => {
    if (!existsSync(specPath)) throw notFound('openapi.yaml not found');
    res.type('application/yaml').send(readFileSync(specPath, 'utf8'));
  });
  app.get('/api/docs', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><title>Gift Card POS API</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({ url: '/api/v1/openapi.yaml', dom_id: '#ui' });</script></body></html>`);
  });

  const v1 = Router();

  // Salon-less routes: sign up a new salon, platform admin.
  v1.use(signupRoutes);
  v1.use(platformRoutes);

  // Which salon is this request for? (terminal key → session → Salon ID).
  // Everything after requireBusiness runs inside that salon's RLS context.
  v1.use(resolveTenant);
  v1.use(requireBusiness);
  v1.use(businessInfo); // salon name for login screens and the kiosk

  // Public customer kiosk (rate limited; no staff session, terminal key optional)
  v1.use('/kiosk', kioskLimiter());
  v1.use(kioskRoutes);

  // Everything below: paired terminal (when REQUIRE_TERMINAL_KEY) …
  v1.use(terminalMiddleware);
  v1.use(authRoutes); // login endpoints are public; the rest authenticate themselves

  // … and a staff session
  v1.get('/events', authenticate, sseHandler);
  v1.use(authenticate);
  v1.use(idempotency({ required: true }));
  v1.use(cardRoutes);
  v1.use(customerRoutes);
  v1.use(historyRoutes);
  v1.use(dashboardRoutes);
  v1.use(adminRoutes);
  v1.use(dataRoutes);
  v1.use((req, _res, next) => next(notFound(`No route ${req.method} ${req.originalUrl}`)));

  app.use('/api/v1', v1);
  app.use(errorHandler);
  return app;
}
