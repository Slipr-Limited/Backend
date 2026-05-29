/**
 * middleware/tipster.middleware.js — Ensures the authenticated user is a tipster.
 * Must run after auth.middleware.protect.
 */

'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Allows only users with isTipster: true.
 * Use: router.post('/', protect, requireTipster, controller)
 */
const requireTipster = (req, _res, next) => {
  if (!req.user?.isTipster) {
    throw new ApiError(403, 'Tipster account required. Enable tipster mode in your settings.');
  }
  next();
};

module.exports = { requireTipster };
