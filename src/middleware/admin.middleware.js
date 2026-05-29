/**
 * middleware/admin.middleware.js — Ensures the authenticated user is a platform admin.
 * Must run after auth.middleware.protect.
 */

'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Allows only users with isAdmin: true.
 * Use: router.put('/ban', protect, requireAdmin, controller)
 */
const requireAdmin = (req, _res, next) => {
  if (!req.user?.isAdmin) {
    throw new ApiError(403, 'Admin access required');
  }
  next();
};

module.exports = { requireAdmin };
