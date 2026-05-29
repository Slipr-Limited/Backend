/**
 * controllers/adminAuth.controller.js — Admin authentication.
 * Separate from user auth — admin panel uses its own JWT that includes adminRole.
 * Admin JWT payload: { id, adminRole, isAdmin: true }
 */

'use strict';

const jwt  = require('jsonwebtoken');
const User = require('../models/User');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');

const ADMIN_ACCESS_EXPIRY  = '8h';
const ADMIN_REFRESH_EXPIRY = '7d';

const signAdminAccess = (user) =>
  jwt.sign(
    { id: user._id, adminRole: user.adminRole, isAdmin: true },
    process.env.JWT_ADMIN_SECRET,
    { expiresIn: ADMIN_ACCESS_EXPIRY, algorithm: 'HS256' }
  );

const signAdminRefresh = (user) =>
  jwt.sign(
    { id: user._id, adminRole: user.adminRole, isAdmin: true },
    process.env.JWT_ADMIN_REFRESH_SECRET,
    { expiresIn: ADMIN_REFRESH_EXPIRY, algorithm: 'HS256' }
  );

/**
 * POST /api/admin/auth/login
 * Body: { email, password }
 */
const adminLogin = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'Email and password are required');

  const user = await User.findOne({
    email: email.toLowerCase(),
    isAdmin: true,
  }).select('+passwordHash +refreshToken');

  if (!user) throw new ApiError(401, 'Invalid credentials');
  if (!user.adminRole) throw new ApiError(401, 'Invalid credentials');

  const valid = await user.comparePassword(password);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  const accessToken  = signAdminAccess(user);
  const refreshToken = signAdminRefresh(user);

  user.refreshToken   = refreshToken;
  user.lastAdminLogin = new Date();
  await user.save({ validateBeforeSave: false });

  const safeUser = {
    _id:          user._id,
    username:     user.username,
    email:        user.email,
    adminRole:    user.adminRole,
    profilePhoto: user.profilePhoto,
    lastAdminLogin: user.lastAdminLogin,
  };

  return ApiResponse.success(res, { user: safeUser, accessToken, refreshToken }, 'Admin login successful');
});

/**
 * POST /api/admin/auth/refresh
 * Body: { refreshToken }
 */
const adminRefresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ApiError(400, 'Refresh token required');

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_ADMIN_REFRESH_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  if (!decoded.isAdmin) throw new ApiError(401, 'Not an admin token');

  const user = await User.findById(decoded.id).select('+refreshToken');
  if (!user || !user.isAdmin || user.refreshToken !== refreshToken) {
    throw new ApiError(401, 'Refresh token reuse detected');
  }

  const newAccess  = signAdminAccess(user);
  const newRefresh = signAdminRefresh(user);

  user.refreshToken = newRefresh;
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(res, { accessToken: newAccess, refreshToken: newRefresh });
});

/**
 * POST /api/admin/auth/logout
 */
const adminLogout = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
  return ApiResponse.success(res, null, 'Logged out');
});

/**
 * GET /api/admin/auth/me
 */
const adminMe = asyncHandler(async (req, res) => {
  const safeUser = {
    _id:            req.user._id,
    username:       req.user.username,
    email:          req.user.email,
    adminRole:      req.user.adminRole,
    profilePhoto:   req.user.profilePhoto,
    lastAdminLogin: req.user.lastAdminLogin,
  };
  return ApiResponse.success(res, { user: safeUser });
});

module.exports = { adminLogin, adminRefresh, adminLogout, adminMe };
