'use strict';

const Notification = require('../models/Notification');
const ApiError     = require('../utils/ApiError');
const ApiResponse  = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');

/**
 * GET /api/notifications
 * Query: page, limit, unreadOnly
 */
const getNotifications = asyncHandler(async (req, res) => {
  const page      = parseInt(req.query.page)  || 1;
  const limit     = parseInt(req.query.limit) || 20;
  const unreadOnly = req.query.unreadOnly === 'true';

  const filter = { user: req.user._id };
  if (unreadOnly) filter.isRead = false;

  const skip = (page - 1) * limit;

  // Run all three DB ops in parallel
  const [total, notifications, unreadCount] = await Promise.all([
    Notification.countDocuments(filter),
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments({ user: req.user._id, isRead: false }),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { notifications, pagination, unreadCount });
});

/**
 * PATCH /api/notifications/:id/read
 */
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOne({
    _id:  req.params.id,
    user: req.user._id,
  });
  if (!notification) throw new ApiError(404, 'Notification not found');

  notification.isRead = true;
  await notification.save();

  return ApiResponse.success(res, null, 'Marked as read');
});

/**
 * PATCH /api/notifications/read-all
 */
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany({ user: req.user._id, isRead: false }, { isRead: true });
  return ApiResponse.success(res, null, 'All notifications marked as read');
});

/**
 * DELETE /api/notifications/:id
 */
const deleteNotification = asyncHandler(async (req, res) => {
  const result = await Notification.deleteOne({ _id: req.params.id, user: req.user._id });
  if (result.deletedCount === 0) throw new ApiError(404, 'Notification not found');
  return ApiResponse.success(res, null, 'Notification deleted');
});

module.exports = { getNotifications, markRead, markAllRead, deleteNotification };
