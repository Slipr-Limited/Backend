/**
 * controllers/social.controller.js — Likes and comments on free listings.
 *
 * Endpoints:
 *   POST   /api/listings/:id/like                       — toggle like (free + paid)
 *   GET    /api/listings/:id/comments                   — paginated comments (free only)
 *   POST   /api/listings/:id/comments                   — create comment (free only)
 *   DELETE /api/listings/:id/comments/:commentId        — soft delete (author/tipster/admin)
 *   POST   /api/listings/:id/comments/:commentId/like   — toggle comment like
 *
 * Comments are restricted to free listings; likes work on all listings.
 */

'use strict';

const Listing          = require('../models/Listing');
const Comment          = require('../models/Comment');
const notificationService = require('../services/notification.service');
const pushService      = require('../services/pushNotification.service');
const ApiError         = require('../utils/ApiError');
const ApiResponse      = require('../utils/ApiResponse');
const asyncHandler     = require('../utils/asyncHandler');
const paginate         = require('../utils/paginate');

// ── Listing like ──────────────────────────────────────────────────────────────

/**
 * POST /api/listings/:id/like
 * Toggles a like on any listing (free or paid).
 * Returns { liked: bool, likeCount: number }.
 */
const toggleListingLike = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id).select('likes likeCount tipster');
  if (!listing) throw new ApiError(404, 'Listing not found');

  const userId    = req.user._id.toString();
  const likedIdx  = listing.likes.findIndex((id) => id.toString() === userId);
  const wasLiked  = likedIdx !== -1;

  if (wasLiked) {
    listing.likes.splice(likedIdx, 1);
    listing.likeCount = Math.max(0, listing.likeCount - 1);
  } else {
    listing.likes.push(req.user._id);
    listing.likeCount += 1;
  }

  await listing.save();

  // Notify tipster on new like (skip self-like)
  if (!wasLiked && listing.tipster.toString() !== req.user._id.toString()) {
    notificationService.sendInApp(
      listing.tipster.toString(),
      'new_like',
      '❤️ Someone liked your tip',
      `@${req.user.username} liked your slip.`,
      { relatedListing: listing._id },
    ).catch(() => {});
    pushService.sendPush(
      listing.tipster.toString(),
      '❤️ New like',
      `@${req.user.username} liked your slip.`,
      { screen: 'SinglePost', listingId: listing._id.toString() },
    ).catch(() => {});
  }

  return ApiResponse.success(res, {
    liked:     !wasLiked,
    likeCount: listing.likeCount,
  }, !wasLiked ? 'Liked' : 'Unliked');
});

// ── Comments on listing ───────────────────────────────────────────────────────

/**
 * GET /api/listings/:id/comments
 * Paginated comments for a FREE listing only.
 */
const getComments = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id).select('isFree');
  if (!listing) throw new ApiError(404, 'Listing not found');
  if (!listing.isFree) throw new ApiError(403, 'Comments are only available on free tips');

  const page  = parseInt(req.query.page,  10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;

  const filter = { listing: listing._id, isDeleted: false };
  const skip   = (page - 1) * limit;

  const [total, comments] = await Promise.all([
    Comment.countDocuments(filter),
    Comment.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('author', 'username profilePhoto isTipster metrics.winRate').lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { comments, pagination });
});

/**
 * POST /api/listings/:id/comments
 * Creates a comment on a FREE listing only.
 * Notifies the tipster.
 */
const createComment = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id).select('isFree tipster commentCount');
  if (!listing) throw new ApiError(404, 'Listing not found');
  if (!listing.isFree) throw new ApiError(403, 'Comments are only allowed on free tips');

  const { text } = req.body;
  if (!text || !text.trim()) throw new ApiError(400, 'Comment text is required');
  if (text.trim().length > 300) throw new ApiError(400, 'Comment must be 300 characters or fewer');

  const comment = await Comment.create({
    listing: listing._id,
    author:  req.user._id,
    text:    text.trim(),
  });

  // Increment comment count on listing
  await Listing.findByIdAndUpdate(listing._id, { $inc: { commentCount: 1 } });

  // Notify tipster (skip if commenter is the tipster)
  if (listing.tipster.toString() !== req.user._id.toString()) {
    const commentPreview = `@${req.user.username} commented: "${text.trim().slice(0, 60)}${text.trim().length > 60 ? '…' : ''}"`;
    notificationService.sendInApp(
      listing.tipster.toString(),
      'new_comment',
      '💬 New comment on your tip',
      commentPreview,
      { relatedListing: listing._id, relatedComment: comment._id },
    ).catch(() => {});
    pushService.sendPush(
      listing.tipster.toString(),
      '💬 New comment',
      commentPreview,
      { screen: 'SinglePost', listingId: listing._id.toString() },
    ).catch(() => {});
  }

  const populated = await comment.populate('author', 'username profilePhoto isTipster metrics.winRate');
  return ApiResponse.success(res, { comment: populated }, 'Comment posted', 201);
});

/**
 * DELETE /api/listings/:id/comments/:commentId
 * Soft delete. Allowed for: comment author, listing tipster, admin.
 */
const deleteComment = asyncHandler(async (req, res) => {
  const [listing, comment] = await Promise.all([
    Listing.findById(req.params.id).select('tipster isFree'),
    Comment.findById(req.params.commentId),
  ]);

  if (!listing) throw new ApiError(404, 'Listing not found');
  if (!comment) throw new ApiError(404, 'Comment not found');
  if (comment.isDeleted) throw new ApiError(410, 'Comment already deleted');

  const isAuthor  = comment.author.toString() === req.user._id.toString();
  const isTipster = listing.tipster.toString() === req.user._id.toString();
  const isAdmin   = req.user.isAdmin;

  if (!isAuthor && !isTipster && !isAdmin) {
    throw new ApiError(403, 'Not authorised to delete this comment');
  }

  comment.isDeleted = true;
  comment.deletedAt = new Date();
  await comment.save();

  await Listing.findByIdAndUpdate(listing._id, {
    $inc: { commentCount: -1 },
  });

  return ApiResponse.success(res, null, 'Comment deleted');
});

// ── Comment like ──────────────────────────────────────────────────────────────

/**
 * POST /api/listings/:id/comments/:commentId/like
 * Toggles a like on a specific comment.
 */
const toggleCommentLike = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.commentId);
  if (!comment) throw new ApiError(404, 'Comment not found');
  if (comment.isDeleted) throw new ApiError(410, 'Cannot like a deleted comment');

  const userId   = req.user._id.toString();
  const likedIdx = comment.likes.findIndex((id) => id.toString() === userId);
  const wasLiked = likedIdx !== -1;

  if (wasLiked) {
    comment.likes.splice(likedIdx, 1);
    comment.likeCount = Math.max(0, comment.likeCount - 1);
  } else {
    comment.likes.push(req.user._id);
    comment.likeCount += 1;
  }

  await comment.save();

  return ApiResponse.success(res, {
    liked:     !wasLiked,
    likeCount: comment.likeCount,
  }, !wasLiked ? 'Liked' : 'Unliked');
});

// ── Admin comment moderation ──────────────────────────────────────────────────

/**
 * GET /api/admin/support/comments
 * All non-deleted comments — for support admin moderation.
 */
const adminGetComments = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page,  10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;

  const filter = { isDeleted: false };
  const total  = await Comment.countDocuments(filter);
  const { skip, limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  const comments = await Comment.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parsedLimit)
    .populate('author', 'username profilePhoto isBanned')
    .populate('listing', 'isFree tipster status')
    .lean();

  return ApiResponse.success(res, { comments, pagination });
});

/**
 * DELETE /api/admin/support/comments/:id
 * Admin force-delete any comment.
 */
const adminDeleteComment = asyncHandler(async (req, res) => {
  const comment = await Comment.findById(req.params.id);
  if (!comment) throw new ApiError(404, 'Comment not found');

  comment.isDeleted = true;
  comment.deletedAt = new Date();
  await comment.save();

  await Listing.findByIdAndUpdate(comment.listing, {
    $inc: { commentCount: -1 },
  });

  return ApiResponse.success(res, null, 'Comment removed');
});

module.exports = {
  toggleListingLike,
  getComments,
  createComment,
  deleteComment,
  toggleCommentLike,
  adminGetComments,
  adminDeleteComment,
};
