/**
 * middleware/rateLimit.middleware.js — Redis-backed rate limiting.
 * Three tiers:
 *   - globalLimiter:   100 req / 15 min per IP (all routes)
 *   - authLimiter:     10  req / 15 min per IP (auth routes)
 *   - purchaseLimiter: 20  req / 15 min per authenticated user
 */

'use strict';

const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedisClient } = require('../config/redis');
const ApiResponse = require('../utils/ApiResponse');

const handler = (_req, res) =>
  ApiResponse.error(res, 'Too many requests — please slow down and try again later.', 429);

/**
 * Creates a rate limiter with lazy Redis store initialisation.
 * The store is only created on the first request — by which time server.js
 * has already called connectRedis(), so Redis is guaranteed to be ready.
 * Falls back to express-rate-limit's built-in memory store if Redis is unavailable.
 */
const createLimiter = (windowMs, max, keyGenerator) => {
  let limiter = null;

  return (req, res, next) => {
    if (!limiter) {
      let store;
      try {
        const redis = getRedisClient();
        store = new RedisStore({
          sendCommand: (...args) => redis.call(...args),
        });
      } catch {
        store = undefined;
      }

      limiter = rateLimit({
        windowMs,
        max,
        store,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator,
        handler,
        skip: (req) => req.user?.isAdmin === true,
      });
    }

    return limiter(req, res, next);
  };
};

// 100 requests per 15 minutes per IP
const globalLimiter = createLimiter(
  15 * 60 * 1000,
  100,
  (req) => req.ip
);

// 10 requests per 15 minutes per IP — for auth endpoints
const authLimiter = createLimiter(
  15 * 60 * 1000,
  10,
  (req) => `auth:${req.ip}`
);

// 20 requests per 15 minutes per authenticated user
const purchaseLimiter = createLimiter(
  15 * 60 * 1000,
  20,
  (req) => `purchase:${req.user?._id || req.ip}`
);

module.exports = { globalLimiter, authLimiter, purchaseLimiter };
