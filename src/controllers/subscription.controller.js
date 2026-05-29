'use strict';

/**
 * controllers/subscription.controller.js
 * Blue-tick verified subscription — ₦21,000/month auto-deducted from wallet.
 *
 * Subscribe  → deducts first month, sets verifiedSubscription + isVerified
 * Cancel     → marks cancelledAt; isVerified stays true until nextBillingDate
 * Status     → returns current subscription state
 */

const User        = require('../models/User');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const { debitWallet } = require('../services/wallet.service');
const generateReference = require('../utils/generateReference');
const logger = require('../utils/logger');

const MONTHLY_FEE = 2100000; // ₦21,000 in kobo

/**
 * POST /api/subscriptions/verified
 * Subscribes the user to the blue-tick plan. Deducts first month immediately.
 */
const subscribe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, 'User not found');

  if (user.verifiedSubscription?.isActive) {
    throw new ApiError(409, 'You already have an active subscription');
  }

  const now             = new Date();
  const nextBillingDate = new Date(now);
  nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);

  // Atomic debit — throws 400 if balance insufficient, prevents race conditions
  const wallet = await debitWallet(req.user._id.toString(), MONTHLY_FEE, {
    type:        'purchase',
    reference:   generateReference('SUB'),
    description: 'Blue-tick verified subscription — first month',
  });

  user.isVerified = true;
  user.verifiedSubscription = {
    isActive:        true,
    startDate:       now,
    nextBillingDate,
    cancelledAt:     null,
  };
  await user.save({ validateBeforeSave: false });

  logger.info(`Subscription: user ${user._id} subscribed to verified plan — ₦${MONTHLY_FEE / 100} deducted`);

  return ApiResponse.success(res, {
    isVerified:           true,
    verifiedSubscription: user.verifiedSubscription,
    newBalance:           wallet.balance / 100,
  }, 'Subscribed! Your blue tick is now active.');
});

/**
 * DELETE /api/subscriptions/verified
 * Cancels the subscription. Blue tick stays until end of current billing period.
 */
const cancelSubscription = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user) throw new ApiError(404, 'User not found');

  if (!user.verifiedSubscription?.isActive) {
    throw new ApiError(400, 'No active subscription to cancel');
  }

  // Mark cancelled — billing job will not charge again, but isVerified stays until nextBillingDate
  user.verifiedSubscription.cancelledAt = new Date();
  user.verifiedSubscription.isActive    = false;
  await user.save({ validateBeforeSave: false });

  logger.info(`Subscription: user ${user._id} cancelled — verified until ${user.verifiedSubscription.nextBillingDate}`);

  return ApiResponse.success(res, {
    verifiedSubscription: user.verifiedSubscription,
    verifiedUntil:        user.verifiedSubscription.nextBillingDate,
  }, `Subscription cancelled. Your blue tick remains active until ${user.verifiedSubscription.nextBillingDate?.toDateString()}.`);
});

/**
 * GET /api/subscriptions/verified
 * Returns current subscription status.
 */
const getSubscriptionStatus = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+verifiedSubscription');
  const wallet = await Wallet.findOne({ user: req.user._id });

  return ApiResponse.success(res, {
    isVerified:           user.isVerified,
    verifiedSubscription: user.verifiedSubscription,
    walletBalance:        (wallet?.balance ?? 0) / 100,
    monthlyFee:           MONTHLY_FEE / 100,
  });
});

module.exports = { subscribe, cancelSubscription, getSubscriptionStatus, MONTHLY_FEE };
