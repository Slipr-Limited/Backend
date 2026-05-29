/**
 * server.js — Application entry point.
 * Loads env, connects to MongoDB and Redis, starts HTTP + Socket.io server,
 * registers all cron jobs, then starts listening.
 */

'use strict';

require('dotenv').config();

const http = require('http');
const app = require('./src/app');
const connectDB = require('./src/config/db');
const connectRedis = require('./src/config/redis');
const { initSocket } = require('./src/config/socket');
const { startNotificationWorker, stopNotificationWorker } = require('./src/workers/notification.worker');
const logger = require('./src/utils/logger');

// Import cron jobs (registration happens on require)
require('./src/jobs/resolveExpired.job');
require('./src/jobs/flagSuspicious.job');
require('./src/jobs/analyticsRefresh.job');
require('./src/jobs/billingJob');
require('./src/jobs/expireBoosts.job');
const { runAutoResolve } = require('./src/jobs/autoResolveTracked.job');
const { startKeepAlive } = require('./src/jobs/keepAlive.job');

const PORT = process.env.PORT || 5000;

// ── Required env guard ──────────────────────────────────────────────────────
const REQUIRED_ENV = [
  'MONGODB_URI', 'JWT_SECRET', 'JWT_REFRESH_SECRET',
  'JWT_ADMIN_SECRET', 'JWT_ADMIN_REFRESH_SECRET',
  'FLW_SECRET_KEY', 'FLW_WEBHOOK_HASH',
  'ENCRYPTION_KEY',
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`❌ Missing required environment variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const server = http.createServer(app);

/**
 * Boot sequence: DB → Redis → Socket.io (with Redis adapter) → Workers → HTTP server
 */
const boot = async () => {
  try {
    await connectDB();

    try {
      await connectRedis();
    } catch (redisErr) {
      logger.warn('Redis unavailable — caching and queues disabled:', redisErr.message);
    }

    // Socket.io must init after Redis so the Redis adapter can attach immediately
    initSocket(server);

    // Start background job worker (processes notify-followers fan-out jobs)
    try {
      startNotificationWorker();
    } catch (workerErr) {
      logger.warn('Notification worker failed to start:', workerErr.message);
    }

    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`🚀 Slipr API running on port ${PORT} [${process.env.NODE_ENV}]`);
      runAutoResolve().catch((err) =>
        logger.error('autoResolveTracked: boot-time run failed:', err),
      );
      startKeepAlive();
    });
  } catch (err) {
    logger.error('Fatal startup error:', err);
    process.exit(1);
  }
};

boot();

// ── Graceful shutdown ───────────────────────────────────────────────────────
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);

  // Stop accepting new connections
  server.close(async () => {
    try {
      await stopNotificationWorker();
      const mongoose = require('mongoose');
      await mongoose.connection.close();
      logger.info('Clean shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown:', err);
      process.exit(1);
    }
  });

  // Force exit if graceful shutdown takes longer than 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30_000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection:', { reason, promise });
  server.close(() => process.exit(1));
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});

module.exports = server;
