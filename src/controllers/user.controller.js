'use strict';

const User    = require('../models/User');
const Follow  = require('../models/Follow');
const Listing = require('../models/Listing');
const Review  = require('../models/Review');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { uploadToCloudinary } = require('../middleware/upload.middleware');
const notificationService = require('../services/notification.service');
const pushService         = require('../services/pushNotification.service');

const getRedis = () => {
  try { return require('../config/redis').getRedisClient(); } catch { return null; }
};
const cacheGet = async (key) => {
  const r = getRedis(); if (!r) return null;
  try { const v = await r.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
};
const cacheSet = async (key, data, ttl) => {
  const r = getRedis(); if (!r) return;
  try { await r.set(key, JSON.stringify(data), 'EX', ttl); } catch { /* non-fatal */ }
};
const cacheDel = async (key) => {
  const r = getRedis(); if (!r) return;
  try { await r.del(key); } catch { /* non-fatal */ }
};

/**
 * GET /api/users/me
 */
const getMe = asyncHandler(async (req, res) => {
  const user = req.user.toJSON();
  return ApiResponse.success(res, { user });
});

/**
 * PATCH /api/users/me
 * Body: { bio, phone, displayName }
 */
const updateMe = asyncHandler(async (req, res) => {
  const allowed = ['bio', 'phone', 'displayName'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (updates.bio && updates.bio.length > 160) {
    throw new ApiError(400, 'Bio must be 160 characters or less');
  }

  const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true, runValidators: true });
  await cacheDel(`profile:${user.username}`);
  return ApiResponse.success(res, { user }, 'Profile updated');
});

/**
 * POST /api/users/me/photo
 * Multipart: field "photo"
 */
const uploadPhoto = asyncHandler(async (req, res) => {
  if (!req.file) throw new ApiError(400, 'No photo file provided');

  const result = await uploadToCloudinary(req.file.buffer, `slipr/avatars/${req.user._id}`);

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { profilePhoto: result.secure_url },
    { new: true }
  );

  await cacheDel(`profile:${user.username}`);
  return ApiResponse.success(res, { user }, 'Photo updated');
});

/**
 * GET /api/users/:username
 * Profile base data cached 5 min; isFollowedByMe computed live (per-viewer).
 */
const getPublicProfile = asyncHandler(async (req, res) => {
  const username = req.params.username.toLowerCase();
  const cacheKey = `profile:${username}`;

  let cached = await cacheGet(cacheKey);
  if (!cached) {
    const user = await User.findOne({ username });
    if (!user) throw new ApiError(404, 'User not found');

    let recentListings = [];
    if (user.isTipster) {
      recentListings = await Listing.find({ tipster: user._id, status: { $in: ['active', 'won', 'lost'] } })
        .sort({ createdAt: -1 })
        .limit(6)
        .select('-bettingCode')
        .lean();
    }

    const profile = user.toJSON();
    // followersCount is now a field on the document — no array computation needed
    cached = { profile, recentListings };
    await cacheSet(cacheKey, cached, 300); // 5 min
  }

  const { profile, recentListings } = cached;

  // isFollowedByMe is viewer-specific — computed live, never stored in shared cache
  if (req.user) {
    profile.isFollowedByMe = !!(await Follow.exists({
      follower:  req.user._id,
      following: profile._id,
    }));
  } else {
    profile.isFollowedByMe = false;
  }

  return ApiResponse.success(res, { user: profile, recentListings });
});

/**
 * POST /api/users/:id/follow
 */
const followUser = asyncHandler(async (req, res) => {
  const targetId = req.params.id;
  if (targetId === req.user._id.toString()) throw new ApiError(400, 'Cannot follow yourself');

  const target = await User.findById(targetId);
  if (!target) throw new ApiError(404, 'User not found');

  // Use Follow collection instead of array check
  const alreadyFollowing = await Follow.exists({ follower: req.user._id, following: targetId });
  if (alreadyFollowing) throw new ApiError(409, 'Already following this user');

  // Create follow relationship + increment counters atomically
  await Follow.create({ follower: req.user._id, following: targetId });
  await User.findByIdAndUpdate(targetId, { $inc: { followersCount: 1 } });

  // Notify the followed user
  notificationService.sendInApp(
    targetId,
    'new_follower',
    '👤 New follower',
    `@${req.user.username} started following you.`,
    {},
  ).catch(() => {});
  pushService.sendPush(
    targetId,
    '👤 New follower',
    `@${req.user.username} is now following you.`,
    { screen: 'TipsterPublicProfile', username: req.user.username },
  ).catch(() => {});

  await cacheDel(`profile:${target.username}`);
  return ApiResponse.success(res, null, `You are now following ${target.username}`);
});

/**
 * DELETE /api/users/:id/follow
 */
const unfollowUser = asyncHandler(async (req, res) => {
  const targetId = req.params.id;
  const target = await User.findById(targetId);
  if (!target) throw new ApiError(404, 'User not found');

  const result = await Follow.deleteOne({ follower: req.user._id, following: targetId });
  if (result.deletedCount > 0) {
    // Only decrement if a follow actually existed
    await User.findByIdAndUpdate(targetId, { $inc: { followersCount: -1 } });
  }

  await cacheDel(`profile:${target.username}`);
  return ApiResponse.success(res, null, `Unfollowed ${target.username}`);
});

/**
 * POST /api/users/kyc
 * Body: { bvn?, nin? }
 */
const submitKYC = asyncHandler(async (req, res) => {
  const { bvn, nin } = req.body;
  if (!bvn && !nin) throw new ApiError(400, 'BVN or NIN required');

  const user = await User.findById(req.user._id).select('+kycData');

  if (bvn) {
    if (!/^\d{11}$/.test(bvn)) throw new ApiError(400, 'BVN must be exactly 11 digits');
    user.setBVN(bvn);
  }
  if (nin) {
    if (!/^\d{11}$/.test(nin)) throw new ApiError(400, 'NIN must be exactly 11 digits');
    user.setNIN(nin);
  }

  user.kycStatus = 'pending';
  await user.save();

  return ApiResponse.success(res, { kycStatus: 'pending' }, 'KYC submitted — under review');
});

/**
 * GET /api/users/:id/reviews
 */
const getTipsterReviews = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip  = (page - 1) * limit;
  const tipsterId = req.params.id;

  const [total, reviews] = await Promise.all([
    Review.countDocuments({ tipster: tipsterId }),
    Review.find({ tipster: tipsterId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('buyer', 'username profilePhoto')
      .lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { reviews, pagination });
});

/**
 * GET /api/users/tipsters
 * Query: page, limit, sort (winRate|totalListings)
 */
const getTipsters = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const sort  = req.query.sort === 'totalListings'
    ? { 'metrics.totalListings': -1 }
    : { 'metrics.winRate': -1 };

  const filter = { isTipster: true, isBanned: false };
  const skip = (page - 1) * limit;

  const [total, tipsters] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort(sort).skip(skip).limit(limit)
      .select('-kycData -passwordHash -refreshToken -emailVerificationToken -passwordResetToken -passwordResetExpires -pushToken -appleId')
      .lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { tipsters, pagination });
});

/**
 * GET /api/users/me/following
 * Returns populated list of tipsters the current user follows.
 */
const getFollowing = asyncHandler(async (req, res) => {
  const follows = await Follow.find({ follower: req.user._id })
    .populate('following', 'username displayName profilePhoto metrics isTipster followersCount isVerified')
    .lean();

  const users = follows
    .map((f) => f.following)
    .filter((u) => u && u.isTipster);

  return ApiResponse.success(res, { users });
});

/**
 * POST /api/users/push-token
 * Body: { token: string } — Expo push token
 */
const registerPushToken = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') throw new ApiError(400, 'token is required');
  await User.findByIdAndUpdate(req.user._id, { pushToken: token });
  return ApiResponse.success(res, null, 'Push token registered');
});

/**
 * DELETE /api/users/push-token
 * Called on logout to stop notifications to this device.
 */
const removePushToken = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { pushToken: null });
  return ApiResponse.success(res, null, 'Push token removed');
});

/**
 * POST /api/users/me/request-verification
 * Body: { reason, socialLink }
 */
const requestVerification = asyncHandler(async (req, res) => {
  const { reason, socialLink } = req.body;
  if (!reason?.trim()) throw new ApiError(400, 'reason is required');

  const user = await User.findById(req.user._id);
  if (user.isVerified) throw new ApiError(400, 'Account is already verified');

  user.verificationRequest = {
    reason:     reason.trim(),
    socialLink: socialLink?.trim() ?? '',
    submittedAt: new Date(),
    status: 'pending',
  };
  await user.save({ validateBeforeSave: false });

  const logger = require('../utils/logger');
  logger.info(`Verification request submitted by user ${user._id}`);
  return ApiResponse.success(res, null, 'Verification request submitted');
});

/**
 * DELETE /api/users/me
 * Body: { password }
 * Permanently deactivates and anonymises the account.
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password) throw new ApiError(400, 'Password is required to delete account');

  const user = await User.findById(req.user._id).select('+passwordHash');
  if (!user) throw new ApiError(404, 'User not found');

  const bcrypt = require('bcryptjs');
  const valid  = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new ApiError(401, 'Incorrect password');

  user.email        = `deleted_${user._id}@removed.invalid`;
  user.username     = `deleted_${user._id}`;
  user.displayName  = 'Deleted User';
  user.bio          = '';
  user.passwordHash = '';
  user.refreshToken = null;
  user.isBanned     = true;
  user.deletedAt    = new Date();
  await user.save({ validateBeforeSave: false });

  const logger = require('../utils/logger');
  logger.warn(`Account deleted: ${req.user._id}`);
  return ApiResponse.success(res, null, 'Account deleted');
});

module.exports = {
  getMe,
  updateMe,
  uploadPhoto,
  getPublicProfile,
  followUser,
  unfollowUser,
  submitKYC,
  getTipsterReviews,
  getTipsters,
  getFollowing,
  registerPushToken,
  removePushToken,
  requestVerification,
  deleteAccount,
};
