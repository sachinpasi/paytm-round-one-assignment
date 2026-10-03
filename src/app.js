import express from 'express';
import { errorHandler, notFound } from './middleware/errors.js';
import readiness from './middleware/readiness.js';
import requestLogger from './middleware/requestLogger.js';
import authRoutes from './routes/auth.js';
import healthRoutes from './routes/health.js';
import reservationRoutes from './routes/reservations.js';
import showRoutes from './routes/shows.js';

export function createApp() {
  const app = express();

  app.use(requestLogger); // first, so even requests that fail early get an id and a log line
  app.use(express.json({ limit: '5mb' })); // the default 100kb is too small for a 100k-seat show

  app.use(healthRoutes);
  app.use(readiness);
  app.use(authRoutes);
  app.use(showRoutes);
  app.use(reservationRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
