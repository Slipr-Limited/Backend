/**
 * controllers/adminFinance.controller.js — Finance admin operations.
 * Transactions, withdrawals, revenue, escrow, refunds.
 */

'use strict';

const Transaction = require('../models/Transaction');
const Wallet = require('../models/Wallet');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { refundToBuyer } = require('../services/escrow.service');
const notificationService = require('../services/notification.service');
const logger = require('../utils/logger');

/**
 * GET /api/admin/finance/transactions
 * Query: page, limit, type, userId, startDate, endDate
 */
const getTransactions = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const filter = {};

  if (req.query.type)   filter.type  = req.query.type;
  if (req.query.userId) filter.user  = req.query.userId;
  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate)   filter.createdAt.$lte = new Date(req.query.endDate);
  }

  const skip = (page - 1) * limit;
  const [total, transactions] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('user', 'username email').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  // Convert kobo to naira
  const result = transactions.map((t) => ({
    ...t,
    amount:        t.amount        / 100,
    balanceBefore: t.balanceBefore / 100,
    balanceAfter:  t.balanceAfter  / 100,
  }));

  return ApiResponse.success(res, { transactions: result, pagination });
});

/**
 * GET /api/admin/finance/withdrawals
 * Query: page, limit, status
 */
const getWithdrawals = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const skip = (page - 1) * limit;
  const [total, withdrawals] = await Promise.all([
    WithdrawalRequest.countDocuments(filter),
    WithdrawalRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('tipster', 'username email profilePhoto').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { withdrawals, pagination });
});

/**
 * PUT /api/admin/finance/withdrawals/:id
 * Body: { action: 'approve' | 'reject', reason? }
 */
const processWithdrawal = asyncHandler(async (req, res) => {
  const { action, reason } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    throw new ApiError(400, 'action must be approve or reject');
  }

  const withdrawal = await WithdrawalRequest.findById(req.params.id)
    .populate('tipster', 'username email');
  if (!withdrawal) throw new ApiError(404, 'Withdrawal request not found');
  if (withdrawal.status !== 'pending') {
    throw new ApiError(400, `Withdrawal is already ${withdrawal.status}`);
  }

  if (action === 'reject') {
    withdrawal.status        = 'failed';
    withdrawal.failureReason = reason || 'Rejected by admin';
    await withdrawal.save();

    // Refund the held amount back to tipster wallet
    const { creditWallet } = require('../services/wallet.service');
    const generateReference = require('../utils/generateReference');
    // withdrawal.amount is in kobo (raw DB value — toJSON only fires on serialization)
    await creditWallet(withdrawal.tipster._id.toString(), withdrawal.amount, {
      type: 'refund',
      reference: generateReference('WD-REJ'),
      description: `Withdrawal rejected: ${withdrawal.failureReason}`,
    });

    await notificationService.sendInApp(
      withdrawal.tipster._id.toString(),
      'withdrawal_failed',
      'Withdrawal rejected',
      `Your withdrawal of ₦${withdrawal.amount / 100} was rejected. Reason: ${withdrawal.failureReason}. Funds returned to your wallet.`,
      {}
    );

    logger.warn(`Withdrawal rejected: ${withdrawal._id} by admin ${req.user._id}`);
    return ApiResponse.success(res, null, 'Withdrawal rejected and funds returned');
  }

  // Approve: (re-)initiate Flutterwave transfer if not already processing.
  // Normally transfers auto-initiate at request time; this path handles manual retry.
  if (withdrawal.status === 'processing' && withdrawal.flwTransferId) {
    logger.info(`Withdrawal ${withdrawal._id} already processing — flwId=${withdrawal.flwTransferId}`);
    return ApiResponse.success(res, null, 'Withdrawal is already being processed');
  }

  withdrawal.status = 'processing';
  await withdrawal.save();

  try {
    const { initiateTransfer } = require('../services/flutterwave.service');
    const transfer = await initiateTransfer(
      withdrawal.amount,  // already in kobo; initiateTransfer divides by 100 internally
      withdrawal.accountNumber,
      withdrawal.bankCode,
      withdrawal.accountName,
      withdrawal.reference || withdrawal._id.toString(),
      'Slipr earnings withdrawal',
    );

    withdrawal.flwTransferId  = transfer.id;
    withdrawal.flwTransferRef = transfer.reference;
    await withdrawal.save();
  } catch (err) {
    logger.error(`FLW transfer error for withdrawal ${withdrawal._id}:`, err.message);
    withdrawal.status        = 'failed';
    withdrawal.failureReason = 'Transfer initiation failed — please retry.';
    await withdrawal.save();
    throw new ApiError(500, 'Could not initiate bank transfer. Please retry.');
  }

  logger.info(`Withdrawal approved: ${withdrawal._id} by admin ${req.user._id}`);
  return ApiResponse.success(res, null, 'Withdrawal approved and transfer initiated');
});

/**
 * GET /api/admin/finance/revenue
 * Query: days (default 30)
 */
const getRevenue = asyncHandler(async (req, res) => {
  const days  = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [totalRevenue, dailyRevenue, monthlyRevenue] = await Promise.all([
    Transaction.aggregate([
      { $match: { type: 'purchase', status: 'success' } },
      { $group: { _id: null, total: { $sum: { $literal: 10000 } }, count: { $sum: 1 } } },
    ]),
    Transaction.aggregate([
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
          purchases: { $sum: 1 },
          revenue:   { $sum: { $literal: 10000 } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      {
        $match: { type: 'purchase', status: 'success' },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          purchases: { $sum: 1 },
          revenue:   { $sum: { $literal: 10000 } },
        },
      },
      { $sort: { _id: -1 } },
      { $limit: 12 },
    ]),
  ]);

  return ApiResponse.success(res, {
    totalRevenue:   (totalRevenue[0]?.total ?? 0) / 100,
    totalPurchases: totalRevenue[0]?.count ?? 0,
    daily: dailyRevenue.map((d) => ({
      date:      d._id,
      revenue:   d.revenue / 100,
      purchases: d.purchases,
    })),
    monthly: monthlyRevenue.map((m) => ({
      month:     m._id,
      revenue:   m.revenue / 100,
      purchases: m.purchases,
    })),
  });
});

/**
 * GET /api/admin/finance/escrow/active
 */
const getActiveEscrow = asyncHandler(async (req, res) => {
  const wallets = await Wallet.aggregate([
    { $match: { escrowBalance: { $gt: 0 } } },
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: 'userInfo',
      },
    },
    { $unwind: '$userInfo' },
    {
      $project: {
        user: '$userInfo.username',
        email: '$userInfo.email',
        escrowBalance: { $divide: ['$escrowBalance', 100] },
        balance: { $divide: ['$balance', 100] },
      },
    },
    { $sort: { escrowBalance: -1 } },
  ]);

  const totalEscrow = wallets.reduce((sum, w) => sum + w.escrowBalance, 0);

  return ApiResponse.success(res, { wallets, totalEscrow });
});

/**
 * GET /api/admin/finance/deposits
 * Query: page, limit, startDate, endDate
 */
const getDeposits = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const filter = { type: 'deposit', status: 'success' };

  if (req.query.startDate || req.query.endDate) {
    filter.createdAt = {};
    if (req.query.startDate) filter.createdAt.$gte = new Date(req.query.startDate);
    if (req.query.endDate)   filter.createdAt.$lte = new Date(req.query.endDate);
  }

  const skip = (page - 1) * limit;
  const [total, deposits] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('user', 'username email').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, {
    deposits: deposits.map((d) => ({ ...d, amount: d.amount / 100 })),
    pagination,
  });
});

/**
 * POST /api/admin/finance/refunds
 * Issues refund under ₦50,000 without super admin approval.
 * Body: { purchaseId, note }
 */
const issueRefund = asyncHandler(async (req, res) => {
  const { purchaseId, note } = req.body;
  if (!purchaseId) throw new ApiError(400, 'purchaseId required');

  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const LIMIT_KOBO = 5000000; // ₦50,000
  if (purchase.escrowAmount > LIMIT_KOBO) {
    throw new ApiError(400, 'Amount exceeds ₦50,000 limit — use /refunds/large route for super admin approval');
  }

  if (!['active', 'disputed'].includes(purchase.status)) {
    throw new ApiError(400, `Cannot refund purchase with status ${purchase.status}`);
  }

  await refundToBuyer(purchaseId);

  logger.warn(`Finance admin refund: purchase=${purchaseId} by=${req.user._id} note="${note}"`);
  return ApiResponse.success(res, null, 'Refund processed');
});

/**
 * POST /api/admin/finance/refunds/large
 * Flags a large refund for super admin approval.
 */
const requestLargeRefund = asyncHandler(async (req, res) => {
  const { purchaseId, note } = req.body;
  if (!purchaseId) throw new ApiError(400, 'purchaseId required');

  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  logger.warn(`Large refund requested: purchase=${purchaseId} by=${req.user._id} note="${note}"`);
  return ApiResponse.success(res, null, 'Large refund flagged for super admin approval');
});

module.exports = {
  getTransactions,
  getWithdrawals,
  processWithdrawal,
  getRevenue,
  getActiveEscrow,
  getDeposits,
  issueRefund,
  requestLargeRefund,
};
