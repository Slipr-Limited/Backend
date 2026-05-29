/**
 * controllers/adminSupport.controller.js — Support admin operations.
 * User management, KYC, dispute initiation, fraud flagging.
 */

'use strict';

const User     = require('../models/User');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const Dispute  = require('../models/Dispute');
const Wallet   = require('../models/Wallet');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const notificationService = require('../services/notification.service');
const logger = require('../utils/logger');

/**
 * GET /api/admin/support/users
 * Query: page, limit, search, isBanned, isFlagged, isTipster, kycStatus
 */
const getUsers = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const filter = { isAdmin: false };

  if (req.query.isBanned  !== undefined) filter.isBanned  = req.query.isBanned  === 'true';
  if (req.query.isFlagged !== undefined) filter.isFlagged = req.query.isFlagged === 'true';
  if (req.query.isTipster !== undefined) filter.isTipster = req.query.isTipster === 'true';
  if (req.query.kycStatus) filter.kycStatus = req.query.kycStatus;
  if (req.query.search) {
    const escaped = req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { username: { $regex: escaped, $options: 'i' } },
      { email:    { $regex: escaped, $options: 'i' } },
    ];
  }

  const skip = (page - 1) * limit;
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .select('-passwordHash -refreshToken -kycData').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { users, pagination });
});

/**
 * GET /api/admin/support/users/:id
 */
const getUserDetail = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+kycData');
  if (!user) throw new ApiError(404, 'User not found');

  const wallet = await Wallet.findOne({ user: user._id });

  return ApiResponse.success(res, { user, wallet });
});

/**
 * PUT /api/admin/support/users/:id/ban
 * Body: { reason }
 */
const banUser = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) throw new ApiError(400, 'Ban reason is required');

  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  if (user.isAdmin) throw new ApiError(400, 'Cannot ban an admin account');

  user.isBanned     = true;
  user.banReason    = reason;
  user.refreshToken = null;
  await user.save({ validateBeforeSave: false });

  await notificationService.sendInApp(
    user._id.toString(),
    'account_banned',
    '⛔ Account suspended',
    `Your account has been suspended. Reason: ${reason}`,
    {}
  );

  logger.warn(`User banned: ${user._id} reason="${reason}" by=${req.user._id}`);
  return ApiResponse.success(res, null, `${user.username} has been banned`);
});

/**
 * PUT /api/admin/support/users/:id/unban
 */
const unbanUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');

  user.isBanned  = false;
  user.banReason = null;
  await user.save({ validateBeforeSave: false });

  await notificationService.sendInApp(
    user._id.toString(),
    'account_unbanned',
    '✅ Account reinstated',
    'Your account suspension has been lifted. Welcome back.',
    {}
  );

  logger.info(`User unbanned: ${user._id} by=${req.user._id}`);
  return ApiResponse.success(res, null, `${user.username} has been unbanned`);
});

/**
 * GET /api/admin/support/users/:id/purchases
 */
const getUserPurchases = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;

  const filter = { buyer: req.params.id };
  const skip   = (page - 1) * limit;
  const [total, purchases] = await Promise.all([
    Purchase.countDocuments(filter),
    Purchase.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('listing', 'platform sport status tipster').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { purchases, pagination });
});

/**
 * GET /api/admin/support/listings/:id — Full listing detail
 */
const getListingDetail = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id)
    .select('+bettingCode')
    .populate('tipster', 'username email profilePhoto metrics')
    .lean();

  if (!listing) throw new ApiError(404, 'Listing not found');

  const purchaseCount = await Purchase.countDocuments({ listing: listing._id });

  return ApiResponse.success(res, { listing, purchaseCount });
});

/**
 * POST /api/admin/support/disputes
 * Opens a dispute on behalf of a user.
 * Body: { purchaseId, userId, reason }
 */
const openDisputeForUser = asyncHandler(async (req, res) => {
  const { purchaseId, userId, reason } = req.body;
  if (!purchaseId || !userId || !reason) {
    throw new ApiError(400, 'purchaseId, userId and reason are required');
  }

  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');
  if (!['active', 'won', 'refunded'].includes(purchase.status)) {
    throw new ApiError(400, 'Can only dispute active or recently settled purchases');
  }

  const existing = await Dispute.findOne({ purchase: purchaseId });
  if (existing) throw new ApiError(409, 'A dispute already exists for this purchase');

  const dispute = await Dispute.create({
    purchase:  purchaseId,
    listing:   purchase.listing._id,
    raisedBy:  userId,
    reason:    `[Admin-initiated on behalf of user] ${reason}`,
    status:    'under_review',
  });

  purchase.status = 'disputed';
  await purchase.save();

  notificationService.notifyAdminDispute(dispute._id.toString(), purchaseId).catch(() => {});

  logger.info(`Dispute opened by support admin ${req.user._id} for user ${userId}`);
  return ApiResponse.success(res, { dispute }, 'Dispute opened', 201);
});

/**
 * PUT /api/admin/support/users/:id/flag
 * Body: { reason }
 */
const flagUser = asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const { reason } = req.body;
  if (!reason) throw new ApiError(400, 'reason is required');

  const user = await User.findByIdAndUpdate(
    userId,
    { isFlagged: true, $push: { flagReasons: reason } },
    { new: true }
  );
  if (!user) throw new ApiError(404, 'User not found');

  logger.warn(`User flagged: ${userId} reason="${reason}" by=${req.user._id}`);
  return ApiResponse.success(res, null, `${user.username} flagged for review`);
});

/**
 * GET /api/admin/support/kyc/pending
 */
const getPendingKYC = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;

  const filter = { kycStatus: 'pending' };
  const skip   = (page - 1) * limit;
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit)
      .select('username email kycStatus createdAt profilePhoto isTipster').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { users, pagination });
});

/**
 * PUT /api/admin/support/kyc/:id
 * Body: { status: 'approved' | 'rejected', note? }
 */
const processKYC = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    throw new ApiError(400, 'status must be approved or rejected');
  }

  const targetUser = await User.findById(req.params.id);
  if (!targetUser) throw new ApiError(404, 'User not found');

  // Grant verified badge: KYC approved + tipster + ≥₦25k lifetime earnings (2,500,000 kobo)
  const VERIFIED_THRESHOLD_KOBO = 2_500_000;
  const isVerified = status === 'approved'
    && targetUser.isTipster
    && (targetUser.metrics?.totalEarned ?? 0) >= VERIFIED_THRESHOLD_KOBO;

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { kycStatus: status, isVerified: isVerified || false },
    { new: true }
  );

  await notificationService.sendInApp(
    user._id.toString(),
    status === 'approved' ? 'kyc_approved' : 'kyc_rejected',
    status === 'approved' ? '✅ KYC Approved' : '❌ KYC Rejected',
    status === 'approved'
      ? 'Your identity has been verified. You can now withdraw earnings.'
      : `Your KYC was not approved. Reason: ${note || 'Does not meet requirements'}. Please resubmit.`,
    {}
  );

  logger.info(`KYC ${status}: userId=${user._id} by=${req.user._id} isVerified=${isVerified}`);
  return ApiResponse.success(res, null, `KYC ${status} for ${user.username}`);
});

module.exports = {
  getUsers,
  getUserDetail,
  banUser,
  unbanUser,
  getUserPurchases,
  getListingDetail,
  openDisputeForUser,
  flagUser,
  getPendingKYC,
  processKYC,
};
