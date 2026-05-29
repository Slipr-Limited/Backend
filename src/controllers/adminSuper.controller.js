/**
 * controllers/adminSuper.controller.js — Super admin only operations.
 * Admin account management, platform settings, manual refunds/payouts, full analytics.
 */

'use strict';

const User     = require('../models/User');
const Wallet   = require('../models/Wallet');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const Transaction = require('../models/Transaction');
const PlatformSettings = require('../models/PlatformSettings');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { releaseToTipster, refundToBuyer } = require('../services/escrow.service');
const { creditWallet } = require('../services/wallet.service');
const generateReference = require('../utils/generateReference');
const logger = require('../utils/logger');

/**
 * GET /api/admin/super/admins
 */
const listAdmins = asyncHandler(async (req, res) => {
  const admins = await User.find({ isAdmin: true })
    .select('username email adminRole adminCreatedAt lastAdminLogin adminCreatedBy isBanned createdAt')
    .populate('adminCreatedBy', 'username email')
    .sort({ adminCreatedAt: -1 })
    .lean();
  return ApiResponse.success(res, { admins });
});

/**
 * POST /api/admin/super/admins
 * Body: { username, email, password, adminRole }
 */
const createAdmin = asyncHandler(async (req, res) => {
  const { username, email, password, adminRole } = req.body;
  const VALID_ROLES = ['finance_admin', 'support_admin', 'escrow_admin'];

  if (!username || !email || !password || !adminRole) {
    throw new ApiError(400, 'username, email, password and adminRole are required');
  }
  if (!VALID_ROLES.includes(adminRole)) {
    throw new ApiError(400, `adminRole must be one of: ${VALID_ROLES.join(', ')}`);
  }
  if (password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters');
  }

  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) {
    throw new ApiError(409, existing.email === email ? 'Email already in use' : 'Username taken');
  }

  const passwordHash = await User.hashPassword(password);
  const admin = await User.create({
    username: username.toLowerCase().trim(),
    email:    email.toLowerCase().trim(),
    passwordHash,
    isAdmin:         true,
    adminRole,
    adminCreatedBy:  req.user._id,
    adminCreatedAt:  new Date(),
    isEmailVerified: true,
  });

  // Create wallet (not used for purchases but keeps schema consistent)
  await Wallet.create({ user: admin._id }).catch(() => {});

  logger.info(`Admin created: ${admin._id} role=${adminRole} by=${req.user._id}`);
  return ApiResponse.success(res, { admin }, 'Admin account created', 201);
});

/**
 * PUT /api/admin/super/admins/:id
 * Body: { adminRole?, isActive? }
 */
const updateAdmin = asyncHandler(async (req, res) => {
  const admin = await User.findById(req.params.id);
  if (!admin) throw new ApiError(404, 'Admin not found');
  if (!admin.isAdmin) throw new ApiError(400, 'User is not an admin');

  // Cannot edit another super admin
  if (admin.adminRole === 'super_admin' && admin._id.toString() !== req.user._id.toString()) {
    throw new ApiError(403, 'Cannot edit another super admin');
  }

  const VALID_ROLES = ['finance_admin', 'support_admin', 'escrow_admin'];
  if (req.body.adminRole) {
    if (!VALID_ROLES.includes(req.body.adminRole)) {
      throw new ApiError(400, `adminRole must be one of: ${VALID_ROLES.join(', ')}`);
    }
    admin.adminRole = req.body.adminRole;
  }

  // Deactivate = isBanned true + refresh cleared
  if (req.body.isActive === false) {
    admin.isBanned     = true;
    admin.refreshToken = null;
  } else if (req.body.isActive === true) {
    admin.isBanned = false;
  }

  await admin.save({ validateBeforeSave: false });
  return ApiResponse.success(res, { admin }, 'Admin updated');
});

/**
 * DELETE /api/admin/super/admins/:id — Deactivates (does not delete)
 */
const deactivateAdmin = asyncHandler(async (req, res) => {
  const admin = await User.findById(req.params.id);
  if (!admin) throw new ApiError(404, 'Admin not found');
  if (!admin.isAdmin) throw new ApiError(400, 'User is not an admin');
  if (admin.adminRole === 'super_admin') throw new ApiError(400, 'Cannot deactivate super admin');

  admin.isBanned     = true;
  admin.refreshToken = null;
  await admin.save({ validateBeforeSave: false });

  logger.warn(`Admin deactivated: ${admin._id} by=${req.user._id}`);
  return ApiResponse.success(res, null, 'Admin account deactivated');
});

/**
 * GET /api/admin/super/settings
 */
const getSettings = asyncHandler(async (req, res) => {
  const settings = await PlatformSettings.getSettings();
  return ApiResponse.success(res, { settings });
});

/**
 * PUT /api/admin/super/settings
 */
const updateSettings = asyncHandler(async (req, res) => {
  const ALLOWED = [
    'platformFeeKobo',
    'minWithdrawalKobo',
    'maxWithdrawalPerDayKobo',
    'escrowResolutionWindowHours',
    'outcomeWindowMinutes',
    'maintenanceMode',
    'maintenanceMessage',
  ];

  const settings = await PlatformSettings.getSettings();
  for (const key of ALLOWED) {
    if (req.body[key] !== undefined) settings[key] = req.body[key];
  }
  await settings.save();

  logger.info(`Platform settings updated by super admin ${req.user._id}`);
  return ApiResponse.success(res, { settings }, 'Settings updated');
});

/**
 * GET /api/admin/super/analytics
 */
const getAnalytics = asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalUsers,
    totalTipsters,
    totalListings,
    activeListings,
    totalPurchases,
    activePurchases,
    totalRevenue,
    pendingEscrow,
  ] = await Promise.all([
    User.countDocuments({ isAdmin: false }),
    User.countDocuments({ isTipster: true, isAdmin: false }),
    Listing.countDocuments(),
    Listing.countDocuments({ status: 'active' }),
    Purchase.countDocuments(),
    Purchase.countDocuments({ status: 'active' }),
    Transaction.aggregate([
      { $match: { type: 'platform_fee', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    Wallet.aggregate([
      { $group: { _id: null, total: { $sum: '$escrowBalance' } } },
    ]),
  ]);

  // Daily revenue for chart
  const dailyRevenue = await Transaction.aggregate([
    {
      $match: {
        type: 'purchase',
        status: 'success',
        createdAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        revenue: { $sum: { $literal: 10000 } }, // ₦100 platform fee per purchase in kobo
        purchases: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const recentUsers = await User.find({ isAdmin: false, createdAt: { $gte: since } })
    .countDocuments();

  return ApiResponse.success(res, {
    totals: {
      users:       totalUsers,
      tipsters:    totalTipsters,
      listings:    totalListings,
      activeListings,
      purchases:   totalPurchases,
      activePurchases,
      revenue:     (totalRevenue[0]?.total ?? 0) / 100,
      escrow:      (pendingEscrow[0]?.total ?? 0) / 100,
      newUsers:    recentUsers,
    },
    dailyRevenue: dailyRevenue.map((d) => ({
      date:      d._id,
      revenue:   d.revenue / 100,
      purchases: d.purchases,
    })),
  });
});

/**
 * POST /api/admin/super/refunds/manual
 * Body: { purchaseId, note }
 */
const manualRefund = asyncHandler(async (req, res) => {
  const { purchaseId, note } = req.body;
  if (!purchaseId) throw new ApiError(400, 'purchaseId required');

  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');
  if (!['active', 'disputed'].includes(purchase.status)) {
    throw new ApiError(400, `Cannot refund purchase with status ${purchase.status}`);
  }

  await refundToBuyer(purchaseId);

  logger.warn(`Manual refund by super admin ${req.user._id}: purchase=${purchaseId} note="${note}"`);
  return ApiResponse.success(res, null, 'Manual refund processed');
});

/**
 * POST /api/admin/super/payouts/manual
 * Body: { purchaseId, note }
 */
const manualPayout = asyncHandler(async (req, res) => {
  const { purchaseId, note } = req.body;
  if (!purchaseId) throw new ApiError(400, 'purchaseId required');

  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');
  if (!['active', 'disputed'].includes(purchase.status)) {
    throw new ApiError(400, `Cannot payout purchase with status ${purchase.status}`);
  }

  await releaseToTipster(purchaseId);

  logger.warn(`Manual payout by super admin ${req.user._id}: purchase=${purchaseId} note="${note}"`);
  return ApiResponse.success(res, null, 'Manual payout processed');
});

/**
 * POST /api/admin/super/analytics/recalc/:tipsterId
 * Force-recalculate a tipster's analytics — use to backfill missing data.
 * POST /api/admin/super/analytics/recalc/all — recalculate every tipster.
 */
const recalcAnalytics = asyncHandler(async (req, res) => {
  const { recalculateAnalytics } = require('../services/analytics.service');
  const { tipsterId } = req.params;

  if (tipsterId === 'all') {
    const tipsters = await User.find({ isTipster: true }).select('_id').lean();
    await Promise.allSettled(
      tipsters.map((u) => recalculateAnalytics(u._id.toString())),
    );
    return ApiResponse.success(res, null, `Analytics recalculated for ${tipsters.length} tipsters`);
  }

  const user = await User.findById(tipsterId);
  if (!user) throw new ApiError(404, 'User not found');

  const analytics = await recalculateAnalytics(tipsterId);
  return ApiResponse.success(res, { analytics }, 'Analytics recalculated');
});

// POST /api/admin/super/resolve-tracked
// Manually triggers auto-resolution of all pending tracked listings.
// Use this to backfill matches that finished while the server was down.
const triggerAutoResolve = asyncHandler(async (_req, res) => {
  const { runAutoResolve } = require('../jobs/autoResolveTracked.job');
  // Run in background — don't await so the request doesn't timeout on large backlogs
  runAutoResolve().catch((err) =>
    require('../utils/logger').error('adminSuper: manual auto-resolve failed:', err),
  );
  return ApiResponse.success(res, null, 'Auto-resolve triggered — check server logs for progress');
});

module.exports = {
  listAdmins,
  createAdmin,
  updateAdmin,
  deactivateAdmin,
  getSettings,
  updateSettings,
  getAnalytics,
  manualRefund,
  manualPayout,
  recalcAnalytics,
  triggerAutoResolve,
};
