'use strict';

const User     = require('../models/User');
const Listing  = require('../models/Listing');
const Purchase = require('../models/Purchase');
const Dispute  = require('../models/Dispute');
const Wallet   = require('../models/Wallet');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { releaseToTipster, refundToBuyer } = require('../services/escrow.service');
const notificationService = require('../services/notification.service');
const logger = require('../utils/logger');

/**
 * GET /api/admin/users
 * Query: page, limit, isBanned, isFlagged, isTipster, search
 */
const getUsers = asyncHandler(async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const filter = { isAdmin: false }; // never expose admin accounts

  if (req.query.isBanned  !== undefined) filter.isBanned  = req.query.isBanned  === 'true';
  if (req.query.isFlagged !== undefined) filter.isFlagged = req.query.isFlagged === 'true';
  if (req.query.isTipster !== undefined) filter.isTipster = req.query.isTipster === 'true';
  if (req.query.search) {
    const escaped = req.query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { username: { $regex: escaped, $options: 'i' } },
      { email:    { $regex: escaped, $options: 'i' } },
    ];
  }

  const SAFE_FIELDS = '-passwordHash -refreshToken -kycData -emailVerificationToken -passwordResetToken -passwordResetExpires -pushToken -appleId';

  const skip = (page - 1) * limit;
  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select(SAFE_FIELDS).lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { users, pagination });
});

/**
 * GET /api/admin/users/:id
 */
const getUserById = asyncHandler(async (req, res) => {
  const [user, wallet] = await Promise.all([
    User.findById(req.params.id).select('+kycData'),
    Wallet.findOne({ user: req.params.id }),
  ]);
  if (!user) throw new ApiError(404, 'User not found');

  return ApiResponse.success(res, { user, wallet });
});

/**
 * POST /api/admin/users/:id/ban
 * Body: { reason }
 */
const banUser = asyncHandler(async (req, res) => {
  const { reason } = req.body;
  if (!reason) throw new ApiError(400, 'Ban reason is required');

  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  if (user.isAdmin) throw new ApiError(400, 'Cannot ban an admin account');

  user.isBanned  = true;
  user.banReason = reason;
  user.refreshToken = null; // Force logout
  await user.save();

  logger.warn(`Admin ban: userId=${user._id}, reason=${reason}, by adminId=${req.user._id}`);
  return ApiResponse.success(res, null, `User ${user.username} has been banned`);
});

/**
 * POST /api/admin/users/:id/unban
 */
const unbanUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');

  user.isBanned  = false;
  user.banReason = null;
  await user.save();

  logger.info(`Admin unban: userId=${user._id}, by adminId=${req.user._id}`);
  return ApiResponse.success(res, null, `User ${user.username} has been unbanned`);
});

/**
 * POST /api/admin/users/:id/unflag
 */
const unflagUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isFlagged: false, $set: { flagReasons: [] } },
    { new: true }
  );
  if (!user) throw new ApiError(404, 'User not found');
  return ApiResponse.success(res, null, `User ${user.username} unflagged`);
});

/**
 * POST /api/admin/users/:id/kyc
 * Body: { status: 'approved' | 'rejected', note? }
 */
const updateKYCStatus = asyncHandler(async (req, res) => {
  const { status, note } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    throw new ApiError(400, 'status must be approved or rejected');
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { kycStatus: status },
    { new: true }
  );
  if (!user) throw new ApiError(404, 'User not found');

  await notificationService.sendInApp(
    user._id.toString(),
    status === 'approved' ? 'kyc_approved' : 'kyc_rejected',
    status === 'approved' ? '✅ KYC Approved' : '❌ KYC Rejected',
    status === 'approved'
      ? 'Your identity has been verified. You can now withdraw earnings.'
      : `Your KYC was not approved. Reason: ${note || 'Does not meet requirements'}`,
    {}
  );

  return ApiResponse.success(res, null, `KYC ${status} for ${user.username}`);
});

/**
 * GET /api/admin/disputes
 * Query: page, limit, status
 */
const getDisputes = asyncHandler(async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 20;
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const skip = (page - 1) * limit;
  const [total, disputes] = await Promise.all([
    Dispute.countDocuments(filter),
    Dispute.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('purchase', 'buyer status')
      .populate('raisedBy', 'username').lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { disputes, pagination });
});

/**
 * POST /api/admin/disputes/:id/resolve
 * Body: { resolution: 'buyer' | 'tipster', note }
 * resolution 'buyer' → refund; resolution 'tipster' → release to tipster
 */
const resolveDispute = asyncHandler(async (req, res) => {
  const { resolution, note } = req.body;
  if (!['buyer', 'tipster'].includes(resolution)) {
    throw new ApiError(400, 'resolution must be buyer or tipster');
  }

  const dispute = await Dispute.findById(req.params.id);
  if (!dispute) throw new ApiError(404, 'Dispute not found');
  if (['resolved_buyer', 'resolved_tipster'].includes(dispute.status)) {
    throw new ApiError(400, 'Dispute is already resolved');
  }

  const purchase = await Purchase.findById(dispute.purchase).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  dispute.status     = resolution === 'buyer' ? 'resolved_buyer' : 'resolved_tipster';
  dispute.adminNote  = note || null;
  dispute.resolvedBy = req.user._id;
  dispute.resolvedAt = new Date();
  await dispute.save();

  if (resolution === 'buyer') {
    await refundToBuyer(purchase._id.toString());
  } else {
    await releaseToTipster(purchase._id.toString());
  }

  // Notify both parties
  const buyerId   = purchase.buyer.toString();
  const tipsterId = purchase.listing.tipster.toString();

  await notificationService.sendInApp(
    buyerId,
    'dispute_resolved',
    '⚖️ Dispute resolved',
    resolution === 'buyer'
      ? 'The dispute was resolved in your favour. Your funds have been refunded.'
      : 'The dispute was resolved in favour of the tipster.',
    { relatedPurchase: purchase._id }
  );

  await notificationService.sendInApp(
    tipsterId,
    'dispute_resolved',
    '⚖️ Dispute resolved',
    resolution === 'tipster'
      ? 'The dispute was resolved in your favour. Earnings have been released to your wallet.'
      : 'The dispute was resolved in favour of the buyer.',
    { relatedPurchase: purchase._id }
  );

  logger.info(`Dispute resolved: disputeId=${dispute._id}, resolution=${resolution}, by adminId=${req.user._id}`);
  return ApiResponse.success(res, null, `Dispute resolved in favour of ${resolution}`);
});

/**
 * POST /api/admin/disputes/:id/review
 * Marks dispute as under_review.
 */
const markDisputeUnderReview = asyncHandler(async (req, res) => {
  const dispute = await Dispute.findByIdAndUpdate(
    req.params.id,
    { status: 'under_review' },
    { new: true }
  );
  if (!dispute) throw new ApiError(404, 'Dispute not found');
  return ApiResponse.success(res, null, 'Dispute marked as under review');
});

/**
 * GET /api/admin/stats
 * Dashboard overview stats.
 */
const getStats = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    totalTipsters,
    totalListings,
    activeListings,
    totalPurchases,
    openDisputes,
    pendingWithdrawals,
    bannedUsers,
    flaggedUsers,
  ] = await Promise.all([
    User.countDocuments({ isAdmin: false }),
    User.countDocuments({ isTipster: true }),
    Listing.countDocuments(),
    Listing.countDocuments({ status: 'active' }),
    Purchase.countDocuments(),
    Dispute.countDocuments({ status: { $in: ['open', 'under_review'] } }),
    WithdrawalRequest.countDocuments({ status: 'pending' }),
    User.countDocuments({ isBanned: true }),
    User.countDocuments({ isFlagged: true }),
  ]);

  return ApiResponse.success(res, {
    totalUsers,
    totalTipsters,
    totalListings,
    activeListings,
    totalPurchases,
    openDisputes,
    pendingWithdrawals,
    bannedUsers,
    flaggedUsers,
  });
});

/**
 * GET /api/admin/listings
 * Query: page, limit, status, tipsterId
 */
const getListings = asyncHandler(async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 20;
  const filter = {};
  if (req.query.status)   filter.status  = req.query.status;
  if (req.query.tipsterId) filter.tipster = req.query.tipsterId;

  const skip = (page - 1) * limit;
  const [total, listings] = await Promise.all([
    Listing.countDocuments(filter),
    Listing.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('tipster', 'username email').select('-trackedMatches').lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { listings, pagination });
});

module.exports = {
  getUsers,
  getUserById,
  banUser,
  unbanUser,
  unflagUser,
  updateKYCStatus,
  getDisputes,
  resolveDispute,
  markDisputeUnderReview,
  getStats,
  getListings,
};
