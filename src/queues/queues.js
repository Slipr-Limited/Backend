'use strict';

const { Queue } = require('bullmq');
const logger = require('../utils/logger');

// Parse Redis URL into BullMQ connection options
const getRedisConfig = () => {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  try {
    const parsed = new URL(url);
    const config = {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port) || 6379,
    };
    if (parsed.password) config.password = decodeURIComponent(parsed.password);
    if (url.startsWith('rediss://')) config.tls = { rejectUnauthorized: false };
    return config;
  } catch {
    return { host: 'localhost', port: 6379 };
  }
};

const connection = getRedisConfig();

// Notification fan-out queue — heavy fan-out (notifyFollowers) runs here, not in the HTTP thread
const notificationQueue = new Queue('notifications', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 500 },
  },
});

notificationQueue.on('error', (err) => logger.warn('notificationQueue Redis error:', err.message));

module.exports = { notificationQueue, connection };
