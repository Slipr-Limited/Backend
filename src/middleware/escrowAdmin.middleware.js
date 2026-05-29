/**
 * middleware/escrowAdmin.middleware.js — escrow_admin + super_admin pass.
 * Must run after auth.middleware.protect.
 */

'use strict';

const ApiError = require('../utils/ApiError');

const ALLOWED = ['super_admin', 'escrow_admin'];

const requireEscrowAdmin = (req, _res, next) => {
  if (!req.user?.isAdmin || !ALLOWED.includes(req.user?.adminRole)) {
    throw new ApiError(403, 'Escrow admin access required');
  }
  next();
};

module.exports = { requireEscrowAdmin };
