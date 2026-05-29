'use strict';

const mongoose    = require('mongoose');
const Wallet      = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const Purchase    = require('../models/Purchase');
const Listing     = require('../models/Listing');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler    = require('../utils/asyncHandler');
const generateReference = require('../utils/generateReference');
const {
  initializePayment,
  verifyTransactionByRef,
} = require('../services/flutterwave.service');
const { creditWallet } = require('../services/wallet.service');

// Convert an array of raw lean Transaction docs (kobo) to naira in-place.
// Needed because .lean() bypasses the model's toJSON transform.
const toNaira = (txs) =>
  txs.map((t) => ({
    ...t,
    amount:        t.amount        / 100,
    balanceBefore: t.balanceBefore / 100,
    balanceAfter:  t.balanceAfter  / 100,
  }));

/**
 * GET /api/wallet
 *
 * Returns the wallet with ALL balance fields accurate in naira.
 * Lifetime totals (totalEarned, totalSpent, totalRefunded, totalWithdrawn) are
 * computed live from the Transaction audit log so they are correct even for
 * users whose Wallet document pre-dates the incremental tracking.
 *
 * Extra computed fields:
 *   pendingEarnings   — tipster's unreleased share in currently-active escrow purchases
 *   activeEscrowCount — buyer's count of slips currently locked in escrow
 */
const getWallet = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // aggregate() does NOT auto-cast unlike find() — must pass an explicit ObjectId
  const oid = new mongoose.Types.ObjectId(userId.toString());

  const [wallet, statsAgg] = await Promise.all([
    Wallet.findOne({ user: userId }),
    // Sum every Transaction by type directly from the immutable audit log.
    // This is the authoritative source — the Wallet counters can be stale for
    // users created before proper increment tracking was added.
    Transaction.aggregate([
      { $match: { user: oid } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
  ]);

  if (!wallet) throw new ApiError(404, 'Wallet not found');

  // Build a type → kobo map from the aggregate
  const byType = {};
  for (const row of statsAgg) byType[row._id] = row.total;

  // wallet.toJSON() already converts kobo → naira for balance / escrowBalance.
  // We override the lifetime counters with the live-computed values (also naira).
  const walletObj = wallet.toJSON();
  walletObj.totalEarned    = (byType['earning']    ?? 0) / 100;
  walletObj.totalSpent     = (byType['purchase']   ?? 0) / 100;
  walletObj.totalRefunded  = (byType['refund']     ?? 0) / 100;
  walletObj.totalWithdrawn = (byType['withdrawal'] ?? 0) / 100;

  let pendingEarnings   = 0;
  let activeEscrowCount = 0;

  if (req.user.isTipster) {
    const myListingIds = await Listing.find({ tipster: userId }).distinct('_id');
    const activePurchases = await Purchase.find({
      listing: { $in: myListingIds },
      status:  'active',
    }).select('escrowAmount platformFee').lean();

    // tipster earns escrowAmount − platformFee per winning purchase
    const totalKobo = activePurchases.reduce(
      (sum, p) => sum + (p.escrowAmount - p.platformFee),
      0,
    );
    pendingEarnings = totalKobo / 100;
  } else {
    activeEscrowCount = await Purchase.countDocuments({ buyer: userId, status: 'active' });
  }

  return ApiResponse.success(res, { wallet: walletObj, pendingEarnings, activeEscrowCount });
});

/**
 * GET /api/wallet/transactions
 * Query: page, limit, type
 *
 * Uses .lean() for performance, then manually converts kobo → naira
 * because .lean() bypasses the Transaction model's toJSON transform.
 */
const getTransactions = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const type  = req.query.type;

  const filter = { user: req.user._id };
  if (type) filter.type = type;

  const skip = (page - 1) * limit;

  const [total, rawTxs] = await Promise.all([
    Transaction.countDocuments(filter),
    Transaction.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const transactions = toNaira(rawTxs);
  const totalPages   = Math.ceil(total / limit);

  return ApiResponse.success(res, {
    transactions,
    pagination: { page, limit, total, totalPages },
  });
});

/**
 * POST /api/wallet/deposit
 * Initiates a Flutterwave Standard checkout.
 * Body: { amount } — amount in naira (min ₦100, max ₦5,000,000)
 */
const initiateDeposit = asyncHandler(async (req, res) => {
  const amountNaira = parseFloat(req.body.amount);

  if (!Number.isFinite(amountNaira) || amountNaira < 100) {
    throw new ApiError(400, 'Minimum deposit is ₦100');
  }
  if (amountNaira > 5_000_000) {
    throw new ApiError(400, 'Maximum deposit is ₦5,000,000');
  }

  const amountKobo = Math.round(amountNaira * 100);
  const txRef      = generateReference('DEP');

  const { link } = await initializePayment(
    req.user.email,
    amountKobo,
    txRef,
    { userId: req.user._id.toString(), type: 'wallet_deposit' },
    'slipr://deposit/callback',
  );

  return ApiResponse.success(res, {
    authorizationUrl: link,
    reference:        txRef,
    amountNaira,
  }, 'Deposit initialised');
});

/**
 * POST /api/wallet/deposit/verify
 * Frontend fallback after Flutterwave redirects back to the app.
 * Body: { reference }
 */
const verifyDeposit = asyncHandler(async (req, res) => {
  const { reference } = req.body;
  if (!reference) throw new ApiError(400, 'Payment reference is required');

  // Idempotency fast-path: webhook already credited this reference
  const existing = await Transaction.findOne({ reference, user: req.user._id });
  if (existing) {
    const wallet = await Wallet.findOne({ user: req.user._id });
    return ApiResponse.success(res, { wallet, alreadyCredited: true }, 'Already credited');
  }

  let tx;
  try {
    tx = await verifyTransactionByRef(reference);
  } catch {
    return ApiResponse.success(res, { status: 'pending' }, 'Payment is being confirmed');
  }

  if (!tx || tx.status !== 'successful') {
    return ApiResponse.success(res, { status: 'pending' }, 'Payment is being confirmed');
  }
  if (tx.currency !== 'NGN') {
    throw new ApiError(400, 'Invalid payment currency');
  }

  const metaUserId = tx.meta?.userId;
  if (metaUserId && metaUserId !== req.user._id.toString()) {
    throw new ApiError(403, 'Payment reference does not belong to this account');
  }
  if (tx.meta?.type !== 'wallet_deposit') {
    throw new ApiError(400, 'This reference is not a wallet deposit');
  }

  const amountKobo = Math.round(tx.amount * 100);
  const wallet = await creditWallet(req.user._id.toString(), amountKobo, {
    type:        'deposit',
    reference,
    description: `Wallet top-up — ₦${tx.amount.toLocaleString()}`,
  });

  return ApiResponse.success(res, { wallet, alreadyCredited: false }, 'Wallet credited successfully');
});

module.exports = { getWallet, getTransactions, initiateDeposit, verifyDeposit };
