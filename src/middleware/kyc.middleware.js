/**
 * middleware/kyc.middleware.js — Ensures the authenticated user has approved KYC.
 * Used exclusively on withdrawal routes.
 * Must run after auth.middleware.protect.
 */

'use strict';

const ApiError = require('../utils/ApiError');

/**
 * Blocks access unless user.kycStatus === 'approved'.
 * Provides context-specific guidance based on current KYC state.
 */
const requireKYC = (req, _res, next) => {
  const { kycStatus } = req.user;

  if (kycStatus === 'approved') {
    return next();
  }

  const messages = {
    none: 'KYC verification required to withdraw. Submit your BVN or NIN in account settings.',
    pending: 'Your KYC is under review. Withdrawals will be enabled once approved (usually within 24 hours).',
    rejected: 'Your KYC was rejected. Please resubmit with valid information.',
  };

  throw new ApiError(403, messages[kycStatus] || 'KYC verification required');
};

module.exports = { requireKYC };
