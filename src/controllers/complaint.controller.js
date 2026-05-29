'use strict';

const Complaint = require('../models/Complaint');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const logger = require('../utils/logger');

const VALID_REASONS = ['fake_tip', 'misleading_odds', 'harassment', 'fraud', 'spam', 'other'];

/**
 * POST /api/complaints
 * Body: { targetType, targetId, reason, description }
 */
const submitComplaint = asyncHandler(async (req, res) => {
  const { targetType, targetId, reason, description } = req.body;

  if (!['user', 'listing'].includes(targetType)) {
    throw new ApiError(400, 'targetType must be user or listing');
  }
  if (!targetId) throw new ApiError(400, 'targetId is required');
  if (!VALID_REASONS.includes(reason)) {
    throw new ApiError(400, `reason must be one of: ${VALID_REASONS.join(', ')}`);
  }
  if (!description || description.trim().length < 10) {
    throw new ApiError(400, 'description is required (min 10 characters)');
  }

  // Prevent spam — one pending complaint per reporter+target
  const existing = await Complaint.findOne({
    reporter: req.user._id,
    targetId,
    status: { $in: ['pending', 'under_review'] },
  });
  if (existing) throw new ApiError(409, 'You already have an open complaint for this item');

  const complaint = await Complaint.create({
    reporter: req.user._id,
    targetType,
    targetId,
    reason,
    description: description.trim(),
  });

  logger.info(`Complaint submitted: ${complaint._id} by ${req.user._id} against ${targetType} ${targetId}`);
  return ApiResponse.success(res, { complaint }, 'Complaint submitted — our team will review it', 201);
});

/**
 * GET /api/admin/support/complaints
 * Query: page, limit, status
 */
const getComplaints = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const skip = (page - 1) * limit;
  const [total, complaints] = await Promise.all([
    Complaint.countDocuments(filter),
    Complaint.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit)
      .populate('reporter', 'username profilePhoto')
      .populate('resolvedBy', 'username').lean(),
  ]);
  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  return ApiResponse.success(res, { complaints, pagination });
});

/**
 * PUT /api/admin/support/complaints/:id
 * Body: { status: 'under_review' | 'resolved' | 'dismissed', adminNote? }
 */
const processComplaint = asyncHandler(async (req, res) => {
  const { status, adminNote } = req.body;
  if (!['under_review', 'resolved', 'dismissed'].includes(status)) {
    throw new ApiError(400, 'status must be under_review, resolved, or dismissed');
  }

  const updates = { status };
  if (['resolved', 'dismissed'].includes(status)) {
    updates.resolvedBy = req.user._id;
    updates.resolvedAt = new Date();
    if (adminNote) updates.adminNote = adminNote;
  }

  const complaint = await Complaint.findByIdAndUpdate(req.params.id, updates, { new: true });
  if (!complaint) throw new ApiError(404, 'Complaint not found');

  logger.info(`Complaint ${req.params.id} → ${status} by admin ${req.user._id}`);
  return ApiResponse.success(res, { complaint }, `Complaint ${status}`);
});

module.exports = { submitComplaint, getComplaints, processComplaint };
