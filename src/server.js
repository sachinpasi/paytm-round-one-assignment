import { createApp } from './app.js';
import config from './config.js';
import { isConnectionError, isPoolTimeout, pool } from './db.js';
import logger from './logger.js';
import { migrate } from './migrate.js';
import { state } from './state.js';

const server = createApp().listen({ port: config.port, backlog: 4096 }, () => {
  logger.info({ port: config.port }, 'listening');
});

// Node drops idle keep-alive sockets after 5s. A load balancer that reuses one just as it closes gets
// a reset, so keep them longer than any proxy in front of us would.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 125_000;

// Serve /healthz straight away but only report ready once the database is migrated. Retry while
// the database is still coming up; anything else (bad migration, wrong password) won't fix itself.
async function waitForDatabase() {
  for (let attempt = 1; !state.stopping; attempt++) {
    try {
      await migrate({ log: (msg) => logger.info(msg) });
      state.ready = true;
      logger.info('database ready, accepting requests');
      return;
    } catch (err) {
      if (!isConnectionError(err) && !isPoolTimeout(err)) {
        logger.fatal({ err }, 'startup failed');
        process.exit(1);
      }
      logger.warn({ attempt, err: err.code ?? err.message }, 'database not reachable yet, retrying');
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 1000, 5000)));
    }
  }
}

// platforms send SIGTERM on deploy: stop accepting, let in-flight requests finish, exit
function shutdown(signal) {
  if (state.stopping) return;
  state.stopping = true;
  logger.info({ signal }, 'shutting down');

  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

waitForDatabase();
