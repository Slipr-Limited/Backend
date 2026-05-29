'use strict';

const Review   = require('../models/Review');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');

/**
 * POST /api/reviews
 * Body: { purchaseId, rating, comment }
 */
const createReview = asyncHandler(async (req, res) => {
  const { purchaseId, rating, comment } = req.body;
  if (!purchaseId || !rating) throw new ApiError(400, 'purchaseId and rating are required');
  if (rating < 1 || rating > 5) throw new ApiError(400, 'Rating must be between 1 and 5');

  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');
  if (purchase.buyer.toString() !== req.user._id.toString()) {
    throw new ApiError(403, 'You can only review your own purchases');
  }
  if (!['won', 'refunded'].includes(purchase.status)) {
    throw new ApiError(400, 'Can only review purchases with a resolved outcome');
  }

  const existing = await Review.findOne({ purchase: purchaseId });
  if (existing) throw new ApiError(409, 'You have already reviewed this purchase');

  const review = await Review.create({
    buyer:    req.user._id,
    tipster:  purchase.listing.tipster,
    listing:  purchase.listing._id,
    purchase: purchaseId,
    rating,
    comment:  comment || null,
    outcome:  purchase.status === 'won' ? 'won' : 'lost',
  });

  await review.populate('buyer', 'username profilePhoto');

  return ApiResponse.success(res, { review }, 'Review submitted', 201);
});

/**
 * GET /api/reviews/tipster/:tipsterId
 */
const getTipsterReviews = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 10;
  const filter = { tipster: req.params.tipsterId };
  const skip   = (page - 1) * limit;

  const [total, reviews, agg] = await Promise.all([
    Review.countDocuments(filter),
    Review.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('buyer', 'username profilePhoto').lean(),
      Review.aggregate([
        { $match: { tipster: require('mongoose').Types.ObjectId.createFromHexString(req.params.tipsterId) } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
      ]),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  const averageRating = agg[0]?.avg ? parseFloat(agg[0].avg.toFixed(2)) : 0;
  const totalReviews  = agg[0]?.count || 0;

  return ApiResponse.success(res, { reviews, pagination, averageRating, totalReviews });
});

/**
 * DELETE /api/reviews/:id
 * Only the buyer can delete their own review, or an admin.
 */
const deleteReview = asyncHandler(async (req, res) => {
  const review = await Review.findById(req.params.id);
  if (!review) throw new ApiError(404, 'Review not found');

  const isOwner = review.buyer.toString() === req.user._id.toString();
  if (!isOwner && !req.user.isAdmin) throw new ApiError(403, 'Not allowed');

  await review.deleteOne();
  return ApiResponse.success(res, null, 'Review deleted');
});

module.exports = { createReview, getTipsterReviews, deleteReview };
