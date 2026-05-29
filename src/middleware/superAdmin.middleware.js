/**
 * middleware/superAdmin.middleware.js — Only super_admin passes.
 * Must run after auth.middleware.protect (req.user must be set).
 */

'use strict';

const ApiError = require('../utils/ApiError');

const requireSuperAdmin = (req, _res, next) => {
  if (!req.user?.isAdmin || req.user?.adminRole !== 'super_admin') {
    throw new ApiError(403, 'Super admin access required');
  }
  next();
};

module.exports = { requireSuperAdmin };
