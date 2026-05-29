/**
 * controllers/adminEscrow.controller.js — Escrow admin operations.
 * Dispute resolution and evidence requests.
 */

'use strict';

const Dispute  = require('../models/Dispute');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const User     = require('../models/User');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { releaseToTipster, refundToBuyer } = require('../services/escrow.service');
const notificationService = require('../services/notification.service');
const pushService         = require('../services/pushNotification.service');
const logger = require('../utils/logger');

/**
 * GET /api/admin/escrow/disputes
 * Query: page, limit, status
 */
const getDisputes = asyncHandler(async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const skip = (page - 1) * limit;
  const [total, disputes] = await Promise.all([
    Dispute.countDocuments(filter),
    Dispute.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate({
      path: 'purchase',
      select: 'buyer status escrowAmount amountPaid',
      populate: { path: 'buyer', select: 'username profilePhoto email' },
    })
    .populate({ path: 'listing', select: 'platform sport tipster', populate: { path: 'tipster', select: 'username profilePhoto' } })
    .populate('raisedBy', 'username')
    .lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { disputes, pagination });
});

/**
 * GET /api/admin/escrow/disputes/:id — Full dispute detail
 */
const getDisputeDetail = asyncHandler(async (req, res) => {
  const dispute = await Dispute.findById(req.params.id)
    .populate({
      path: 'purchase',
      populate: [
        { path: 'buyer', select: 'username email profilePhoto' },
        { path: 'listing', select: 'platform sport numberOfGames totalOdds kickoffTime closingTime tipster bettingCode', populate: { path: 'tipster', select: 'username email profilePhoto metrics' } },
      ],
    })
    .populate('raisedBy', 'username email')
    .populate('resolvedBy', 'username');

  if (!dispute) throw new ApiError(404, 'Dispute not found');

  return ApiResponse.success(res, { dispute });
});

/**
 * PUT /api/admin/escrow/disputes/:id/resolve
 * Body: { verdict: 'buyer' | 'tipster', note }
 */
const resolveDispute = asyncHandler(async (req, res) => {
  const { verdict, note } = req.body;
  if (!['buyer', 'tipster'].includes(verdict)) {
    throw new ApiError(400, 'verdict must be buyer or tipster');
  }
  if (!note || note.trim().length < 10) {
    throw new ApiError(400, 'Admin note is required (min 10 characters)');
  }

  const dispute = await Dispute.findById(req.params.id);
  if (!dispute) throw new ApiError(404, 'Dispute not found');
  if (['resolved_buyer', 'resolved_tipster'].includes(dispute.status)) {
    throw new ApiError(400, 'Dispute is already resolved');
  }

  const purchase = await Purchase.findById(dispute.purchase).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  dispute.status     = verdict === 'buyer' ? 'resolved_buyer' : 'resolved_tipster';
  dispute.adminNote  = note;
  dispute.resolvedBy = req.user._id;
  dispute.resolvedAt = new Date();
  await dispute.save();

  const buyerId   = purchase.buyer.toString();
  const tipsterId = purchase.listing.tipster.toString();

  if (verdict === 'buyer') {
    // refundToBuyer already calls updateTipsterMetrics + recalculateAnalytics internally
    await refundToBuyer(purchase._id.toString());

    const refundNaira = (purchase.escrowAmount / 100).toLocaleString();
    await notificationService.sendInApp(
      buyerId,
      'dispute_resolved',
      '⚖️ Dispute resolved in your favour',
      `Your dispute was resolved. ₦${refundNaira} has been returned to your wallet.`,
      { relatedPurchase: purchase._id }
    );
    pushService.sendPush(
      buyerId,
      '⚖️ Dispute resolved in your favour',
      `Your dispute was resolved. ₦${refundNaira} has been returned to your wallet.`,
      { screen: 'Wallet' },
    ).catch(() => {});

    await notificationService.sendInApp(
      tipsterId,
      'dispute_resolved',
      '⚖️ Dispute resolved',
      'The dispute was resolved in favour of the buyer.',
      { relatedPurchase: purchase._id }
    );
    pushService.sendPush(
      tipsterId,
      '⚖️ Dispute resolved',
      'The dispute on your listing was resolved in favour of the buyer.',
      { screen: 'MyListings' },
    ).catch(() => {});
  } else {
    // releaseToTipster already calls updateTipsterMetrics + recalculateAnalytics internally
    await releaseToTipster(purchase._id.toString());

    const earnNaira = (purchase.escrowAmount / 100).toLocaleString();
    await notificationService.sendInApp(
      tipsterId,
      'dispute_resolved',
      '⚖️ Dispute resolved in your favour',
      `Your dispute was resolved. ₦${earnNaira} has been added to your wallet.`,
      { relatedPurchase: purchase._id }
    );
    pushService.sendPush(
      tipsterId,
      '⚖️ Dispute resolved in your favour',
      `Your dispute was resolved. ₦${earnNaira} has been added to your wallet.`,
      { screen: 'Wallet' },
    ).catch(() => {});

    await notificationService.sendInApp(
      buyerId,
      'dispute_resolved',
      '⚖️ Dispute resolved',
      'The dispute was resolved in favour of the tipster.',
      { relatedPurchase: purchase._id }
    );
    pushService.sendPush(
      buyerId,
      '⚖️ Dispute resolved',
      'The dispute was resolved in favour of the tipster.',
      { screen: 'MyPurchases' },
    ).catch(() => {});
  }

  logger.info(`Dispute resolved: ${dispute._id} verdict=${verdict} by=${req.user._id}`);
  return ApiResponse.success(res, null, `Dispute resolved in favour of ${verdict}`);
});

/**
 * PUT /api/admin/escrow/disputes/:id/escalate
 * Body: { note }
 */
const escalateDispute = asyncHandler(async (req, res) => {
  const dispute = await Dispute.findByIdAndUpdate(
    req.params.id,
    {
      status: 'under_review',
      adminNote: `[Escalated to super admin] ${req.body.note || ''}`,
    },
    { new: true }
  );
  if (!dispute) throw new ApiError(404, 'Dispute not found');

  // Notify super admin via socket
  notificationService.notifyAdminDispute(dispute._id.toString(), dispute.purchase.toString()).catch(() => {});

  logger.info(`Dispute escalated: ${dispute._id} by=${req.user._id}`);
  return ApiResponse.success(res, null, 'Dispute escalated to super admin');
});

/**
 * PUT /api/admin/escrow/disputes/:id/evidence
 * Body: { party: 'buyer' | 'tipster', message }
 */
const requestEvidence = asyncHandler(async (req, res) => {
  const { party, message } = req.body;
  if (!['buyer', 'tipster'].includes(party)) {
    throw new ApiError(400, 'party must be buyer or tipster');
  }

  const dispute = await Dispute.findById(req.params.id)
    .populate({ path: 'purchase', populate: { path: 'listing', select: 'tipster' } });
  if (!dispute) throw new ApiError(404, 'Dispute not found');

  let recipientId;
  if (party === 'buyer') {
    recipientId = dispute.purchase.buyer.toString();
  } else {
    recipientId = dispute.purchase.listing.tipster.toString();
  }

  await notificationService.sendInApp(
    recipientId,
    'evidence_requested',
    '📎 Additional evidence requested',
    message || 'The escrow admin has requested additional evidence for your dispute.',
    { relatedPurchase: dispute.purchase._id }
  );

  return ApiResponse.success(res, null, `Evidence requested from ${party}`);
});

/**
 * GET /api/admin/escrow/pending
 * All purchases awaiting outcome resolution (listing closed, purchase still active)
 */
const getPendingOutcomes = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;

  const filter = {
    status:      'active',
    closingTime: { $lt: new Date() }, // listing has closed but purchase not yet settled
  };

  const skip = (page - 1) * limit;
  const [total, purchases] = await Promise.all([
    Purchase.countDocuments(filter),
    Purchase.find(filter).sort({ closingTime: 1 }).skip(skip).limit(limit)
      .populate({ path: 'listing', select: 'platform sport kickoffTime closingTime tipster', populate: { path: 'tipster', select: 'username' } })
      .populate('buyer', 'username').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { purchases, pagination });
});

module.exports = {
  getDisputes,
  getDisputeDetail,
  resolveDispute,
  escalateDispute,
  requestEvidence,
  getPendingOutcomes,
};
