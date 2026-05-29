/**
 * config/redis.js — ioredis client singleton.
 * Used for rate limiting, feed caching, and session management.
 * Exports both the connect function and the client instance.
 */

'use strict';

const { Redis } = require('ioredis');
const logger = require('../utils/logger');

let redisClient = null;

/**
 * Initialises the Redis connection.
 * Called during server boot — server.js awaits this.
 */
const connectRedis = async () => {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  const tlsOptions = url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {};

  redisClient = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    ...tlsOptions,
  });

  await redisClient.connect();

  redisClient.on('connect', () => logger.info('Redis connected'));
  redisClient.on('error', (err) => logger.error('Redis error:', err));
  redisClient.on('close', () => logger.warn('Redis connection closed'));

  return redisClient;
};

/**
 * Returns the cached Redis client instance.
 * Throws if connectRedis() has not been called yet.
 */
const getRedisClient = () => {
  if (!redisClient) throw new Error('Redis client not initialised. Call connectRedis() first.');
  return redisClient;
};

module.exports = connectRedis;
module.exports.getRedisClient = getRedisClient;
