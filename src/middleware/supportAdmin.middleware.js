/**
 * middleware/supportAdmin.middleware.js — support_admin + super_admin pass.
 * Must run after auth.middleware.protect.
 */

'use strict';

const ApiError = require('../utils/ApiError');

const ALLOWED = ['super_admin', 'support_admin'];

const requireSupportAdmin = (req, _res, next) => {
  if (!req.user?.isAdmin || !ALLOWED.includes(req.user?.adminRole)) {
    throw new ApiError(403, 'Support admin access required');
  }
  next();
};

module.exports = { requireSupportAdmin };
