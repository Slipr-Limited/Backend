/**
 * middleware/rateLimit.middleware.js — In-memory rate limiting.
 * Three tiers:
 *   - globalLimiter:   100 req / 15 min per IP (all routes)
 *   - authLimiter:     10  req / 15 min per IP (auth endpoints)
 *   - purchaseLimiter: 20  req / 15 min per authenticated user
 *
 * Uses express-rate-limit's built-in memory store — no Redis dependency.
 * This avoids connection-timing issues at startup and is correct for a
 * single-process Node server. Upgrade to a shared store if you add PM2
 * cluster mode or multiple dynos.
 */

'use strict';

const rateLimit = require('express-rate-limit');
const ApiResponse = require('../utils/ApiResponse');

const handler = (_req, res) =>
  ApiResponse.error(res, 'Too many requests — please slow down and try again later.', 429);

const makeLimiter = (windowMs, max, keyGenerator) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator,
    handler,
    skip: (req) => req.user?.isAdmin === true,
  });

const globalLimiter = makeLimiter(
  15 * 60 * 1000,
  100,
  (req) => req.ip,
);

const authLimiter = makeLimiter(
  15 * 60 * 1000,
  10,
  (req) => `auth:${req.ip}`,
);

const purchaseLimiter = makeLimiter(
  15 * 60 * 1000,
  20,
  (req) => `purchase:${req.user?._id || req.ip}`,
);

module.exports = { globalLimiter, authLimiter, purchaseLimiter };
