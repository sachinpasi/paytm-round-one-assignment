import pino from 'pino';
import config from './config.js';

const logger = pino({
  level: config.logLevel,
  base: { service: 'paytm-round-one-assignment' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
