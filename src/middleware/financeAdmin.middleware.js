/**
 * middleware/financeAdmin.middleware.js — finance_admin + super_admin pass.
 * Must run after auth.middleware.protect.
 */

'use strict';

const ApiError = require('../utils/ApiError');

const ALLOWED = ['super_admin', 'finance_admin'];

const requireFinanceAdmin = (req, _res, next) => {
  if (!req.user?.isAdmin || !ALLOWED.includes(req.user?.adminRole)) {
    throw new ApiError(403, 'Finance admin access required');
  }
  next();
};

module.exports = { requireFinanceAdmin };
