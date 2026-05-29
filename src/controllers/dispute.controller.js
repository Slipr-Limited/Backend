'use strict';

const Dispute  = require('../models/Dispute');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { createDispute } = require('../services/outcome.service');

/**
 * POST /api/disputes
 * Buyer or tipster manually raises a dispute.
 * Body: { purchaseId, reason }
 */
const raiseDispute = asyncHandler(async (req, res) => {
  const { purchaseId, reason } = req.body;
  if (!purchaseId || !reason) throw new ApiError(400, 'purchaseId and reason are required');
  if (reason.length > 1000) throw new ApiError(400, 'Reason must be 1000 characters or less');

  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const isBuyer   = purchase.buyer.toString() === req.user._id.toString();
  const isTipster = purchase.listing.tipster.toString() === req.user._id.toString();
  if (!isBuyer && !isTipster) throw new ApiError(403, 'Only the buyer or tipster can raise a dispute');

  if (!['active', 'won', 'refunded'].includes(purchase.status)) {
    throw new ApiError(400, 'A dispute cannot be raised on this purchase in its current state');
  }

  const dispute = await createDispute(purchaseId, reason, req.user._id.toString());

  return ApiResponse.success(res, { dispute }, 'Dispute raised — our team will review within 24 hours', 201);
});

/**
 * GET /api/disputes/mine
 */
const getMyDisputes = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;

  const userPurchaseIds = await Purchase.find({
    $or: [{ buyer: req.user._id }],
  }).distinct('_id');

  const userListingIds = await Listing.find({ tipster: req.user._id }).distinct('_id');

  const filter = {
    $or: [
      { purchase: { $in: userPurchaseIds } },
      { listing:  { $in: userListingIds } },
    ],
  };

  const skip = (page - 1) * limit;
  const [total, disputes] = await Promise.all([
    Dispute.countDocuments(filter),
    Dispute.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('purchase', 'status').lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { disputes, pagination });
});

/**
 * GET /api/disputes/:id
 */
const getDispute = asyncHandler(async (req, res) => {
  const dispute = await Dispute.findById(req.params.id)
    .populate('purchase', 'status buyer')
    .populate('raisedBy', 'username');

  if (!dispute) throw new ApiError(404, 'Dispute not found');

  const purchase = await Purchase.findById(dispute.purchase._id).populate('listing');
  const isBuyer   = purchase?.buyer.toString() === req.user._id.toString();
  const isTipster = purchase?.listing?.tipster.toString() === req.user._id.toString();
  if (!isBuyer && !isTipster && !req.user.isAdmin) throw new ApiError(403, 'Access denied');

  return ApiResponse.success(res, { dispute });
});

module.exports = { raiseDispute, getMyDisputes, getDispute };
