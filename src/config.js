const env = process.env;

if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

const config = {
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL || 'postgres://seatres:seatres@localhost:5432/seatres',
  databaseSsl: env.DATABASE_SSL === 'true',
  poolSize: Number(env.DB_POOL_MAX) || 40,
  poolWaitMs: Number(env.DB_POOL_WAIT_MS) || 10_000,
  jwtSecret: env.JWT_SECRET || 'dev-only-secret-change-me',
  // stand-in for a real identity provider: whoever has this can mint admin tokens
  adminKey: env.ADMIN_KEY || 'demo-admin-key',
  tokenTtl: Number(env.TOKEN_TTL_SECONDS) || 12 * 3600,
  logLevel: env.LOG_LEVEL || 'info',
};

export default config;
