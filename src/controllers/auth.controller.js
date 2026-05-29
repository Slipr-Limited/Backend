'use strict';

const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const axios  = require('axios');
const User   = require('../models/User');
const Wallet = require('../models/Wallet');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const { sendEmail } = require('../services/notification.service');
const logger = require('../utils/logger');

const ACCESS_TOKEN_EXPIRY  = '15m';
const REFRESH_TOKEN_EXPIRY = '30d';

const signAccess = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY, algorithm: 'HS256' });

const signRefresh = (id) =>
  jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRY, algorithm: 'HS256' });

/**
 * POST /api/auth/register
 * Body: { username, email, password }
 */
const register = asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    throw new ApiError(400, 'username, email and password are required');
  }
  if (password.length < 8) {
    throw new ApiError(400, 'Password must be at least 8 characters');
  }

  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) {
    throw new ApiError(409, existing.email === email ? 'Email already in use' : 'Username already taken');
  }

  const passwordHash = await User.hashPassword(password);
  const emailVerificationToken = crypto.randomBytes(32).toString('hex');

  const user = await User.create({
    username: username.toLowerCase().trim(),
    email: email.toLowerCase().trim(),
    passwordHash,
    emailVerificationToken,
  });

  // Create wallet for user
  await Wallet.create({ user: user._id });

  // Send verification email (non-fatal)
  try {
    const verifyUrl = `${process.env.FRONTEND_URL}/verify-email?token=${emailVerificationToken}`;
    await sendEmail(
      user.email,
      'Verify your Slipr account',
      `<p>Hi ${user.username},</p><p>Click <a href="${verifyUrl}">here</a> to verify your email.</p>`
    );
  } catch (err) {
    logger.warn('register: verification email failed:', err.message);
  }

  const accessToken  = signAccess(user._id);
  const refreshToken = signRefresh(user._id);

  await User.findByIdAndUpdate(user._id, { refreshToken });

  return ApiResponse.success(res, {
    user,
    accessToken,
    refreshToken,
  }, 'Account created successfully', 201);
});

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw new ApiError(400, 'Email and password are required');

  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash +refreshToken');
  if (!user) throw new ApiError(401, 'Invalid credentials');
  if (user.isBanned) throw new ApiError(403, `Account suspended: ${user.banReason || 'Policy violation'}`);

  const valid = await user.comparePassword(password);
  if (!valid) throw new ApiError(401, 'Invalid credentials');

  const accessToken  = signAccess(user._id);
  const refreshToken = signRefresh(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(res, {
    user,
    accessToken,
    refreshToken,
  }, 'Logged in successfully');
});

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 */
const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) throw new ApiError(400, 'Refresh token required');

  let decoded;
  try {
    decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
  } catch {
    throw new ApiError(401, 'Invalid or expired refresh token');
  }

  const user = await User.findById(decoded.id).select('+refreshToken');
  if (!user || user.refreshToken !== refreshToken) {
    throw new ApiError(401, 'Refresh token reuse detected — please log in again');
  }
  if (user.isBanned) throw new ApiError(403, 'Account suspended');

  const newAccess  = signAccess(user._id);
  const newRefresh = signRefresh(user._id);

  user.refreshToken = newRefresh;
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(res, { accessToken: newAccess, refreshToken: newRefresh }, 'Token refreshed');
});

/**
 * POST /api/auth/logout
 * Requires auth header — clears stored refresh token.
 */
const logout = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { refreshToken: null });
  return ApiResponse.success(res, null, 'Logged out successfully');
});

/**
 * GET /api/auth/verify-email?token=
 */
const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) throw new ApiError(400, 'Verification token required');

  const user = await User.findOne({ emailVerificationToken: token }).select('+emailVerificationToken');
  if (!user) throw new ApiError(400, 'Invalid or expired verification token');

  user.isEmailVerified = true;
  user.emailVerificationToken = null;
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(res, null, 'Email verified successfully');
});

/**
 * POST /api/auth/forgot-password
 * Body: { email }
 */
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (!email) throw new ApiError(400, 'Email is required');

  const user = await User.findOne({ email: email.toLowerCase() });
  // Always respond 200 to prevent email enumeration
  if (!user) {
    return ApiResponse.success(res, null, 'If that email exists, a reset link has been sent');
  }

  const resetToken  = crypto.randomBytes(32).toString('hex');
  const resetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  user.passwordResetToken   = resetToken;
  user.passwordResetExpires = resetExpiry;
  await user.save({ validateBeforeSave: false });

  try {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
    await sendEmail(
      user.email,
      'Reset your Slipr password',
      `<p>Hi ${user.username},</p><p>Click <a href="${resetUrl}">here</a> to reset your password. This link expires in 1 hour.</p>`
    );
  } catch (err) {
    user.passwordResetToken   = null;
    user.passwordResetExpires = null;
    await user.save({ validateBeforeSave: false });
    throw new ApiError(500, 'Could not send reset email — please try again');
  }

  return ApiResponse.success(res, null, 'If that email exists, a reset link has been sent');
});

/**
 * POST /api/auth/reset-password
 * Body: { token, password }
 */
const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) throw new ApiError(400, 'Token and new password are required');
  if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters');

  const user = await User.findOne({
    passwordResetToken:   token,
    passwordResetExpires: { $gt: new Date() },
  }).select('+passwordResetToken +passwordResetExpires');

  if (!user) throw new ApiError(400, 'Invalid or expired reset token');

  user.passwordHash         = await User.hashPassword(password);
  user.passwordResetToken   = null;
  user.passwordResetExpires = null;
  user.refreshToken         = null; // Invalidate all sessions
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(res, null, 'Password reset successfully — please log in');
});

/**
 * POST /api/auth/google
 * Body: { idToken } — Google ID token from mobile OAuth flow.
 * Verifies with Google, then finds or creates a user account.
 */
const googleAuth = asyncHandler(async (req, res) => {
  const { idToken, isTipster = false } = req.body;
  if (!idToken) throw new ApiError(400, 'idToken is required');

  // Verify token with Google's tokeninfo endpoint
  let googlePayload;
  try {
    const { data } = await axios.get(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`,
      { timeout: 8000 }
    );
    googlePayload = data;
  } catch (err) {
    logger.warn('Google auth token verification failed:', err.message);
    throw new ApiError(401, 'Invalid Google token — please try signing in again');
  }

  const { email, name, sub: googleId, picture } = googlePayload;

  if (!email) throw new ApiError(400, 'Could not retrieve email from Google account');

  // Validate audience if GOOGLE_CLIENT_ID is set
  if (process.env.GOOGLE_CLIENT_ID && googlePayload.aud !== process.env.GOOGLE_CLIENT_ID) {
    throw new ApiError(401, 'Google token audience mismatch');
  }

  // Find or create user
  let user = await User.findOne({ email: email.toLowerCase() }).select('+refreshToken');
  let isNew = false;

  if (!user) {
    isNew = true;

    // Generate a unique username from their Google name
    const baseName = (name || email.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 20) || 'user';

    let username = baseName;
    let attempt  = 0;
    while (await User.exists({ username })) {
      attempt++;
      username = `${baseName}${attempt}`;
    }

    // Google users don't have a password — set a random unusable hash
    const randomPasswordHash = await require('bcryptjs').hash(crypto.randomBytes(24).toString('hex'), 10);

    user = await User.create({
      username,
      email:           email.toLowerCase(),
      passwordHash:    randomPasswordHash,
      isEmailVerified: true, // Google email is already verified
      profilePhoto:    picture || null,
      displayName:     name || username,
      isTipster:       Boolean(isTipster),
    });

    await Wallet.create({ user: user._id });
    logger.info(`Google sign-in: new user created username=${username} googleId=${googleId}`);
  } else {
    if (user.isBanned) throw new ApiError(403, `Account suspended: ${user.banReason || 'Policy violation'}`);

    // Update profile photo if it was empty
    if (!user.profilePhoto && picture) {
      user.profilePhoto = picture;
    }
    logger.info(`Google sign-in: existing user ${user._id}`);
  }

  const accessToken  = signAccess(user._id);
  const refreshToken = signRefresh(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(
    res,
    { user, accessToken, refreshToken },
    isNew ? 'Account created with Google' : 'Logged in with Google'
  );
});

// In-memory JWKS cache — Apple keys rotate rarely, cache for 1 hour
let _appleJwksCache = null;
let _appleJwksCachedAt = 0;

const getAppleJwks = async () => {
  if (_appleJwksCache && (Date.now() - _appleJwksCachedAt) < 3_600_000) {
    return _appleJwksCache;
  }
  const { data } = await axios.get('https://appleid.apple.com/auth/keys', { timeout: 8000 });
  _appleJwksCache    = data.keys;
  _appleJwksCachedAt = Date.now();
  return data.keys;
};

/**
 * POST /api/auth/apple
 * Body: { identityToken, fullName? }
 * Verifies the Apple identity token using Apple's JWKS, then finds or creates a user.
 */
const appleAuth = asyncHandler(async (req, res) => {
  const { identityToken, fullName, isTipster = false } = req.body;
  if (!identityToken) throw new ApiError(400, 'identityToken is required');

  // Decode header to get kid
  let header;
  try {
    header = JSON.parse(Buffer.from(identityToken.split('.')[0], 'base64url').toString());
  } catch {
    throw new ApiError(400, 'Malformed Apple identity token');
  }

  // Fetch Apple's public keys and find the matching one
  let applePayload;
  try {
    const keys = await getAppleJwks();
    const jwk  = keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error(`No Apple JWK found for kid: ${header.kid}`);

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    applePayload = jwt.verify(identityToken, publicKey, {
      algorithms: ['RS256'],
      issuer:     'https://appleid.apple.com',
      audience:   process.env.APPLE_BUNDLE_ID,
    });
  } catch (err) {
    logger.warn('Apple auth token verification failed:', err.message);
    throw new ApiError(401, 'Invalid Apple token — please try signing in again');
  }

  const appleId = applePayload.sub;
  const email   = applePayload.email ?? null;

  // Find existing user by appleId first, then by email
  let user = await User.findOne({ appleId }).select('+refreshToken +appleId');
  let isNew = false;

  if (!user && email) {
    user = await User.findOne({ email: email.toLowerCase() }).select('+refreshToken +appleId');
    if (user) {
      // Link existing account to Apple ID
      user.appleId = appleId;
    }
  }

  if (!user) {
    if (!email) throw new ApiError(400, 'Apple did not provide an email address. Please try signing in again.');

    isNew = true;

    // Build a username from the Apple-provided full name or email
    const givenName  = fullName?.givenName  ?? '';
    const familyName = fullName?.familyName ?? '';
    const baseName = (givenName + familyName || email.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 20) || 'user';

    let username = baseName;
    let attempt  = 0;
    while (await User.exists({ username })) {
      attempt++;
      username = `${baseName}${attempt}`;
    }

    const displayName = [givenName, familyName].filter(Boolean).join(' ') || username;
    const randomHash  = await require('bcryptjs').hash(crypto.randomBytes(24).toString('hex'), 10);

    user = await User.create({
      username,
      email:           email.toLowerCase(),
      passwordHash:    randomHash,
      isEmailVerified: true,
      displayName,
      appleId,
      isTipster:       Boolean(isTipster),
    });

    await Wallet.create({ user: user._id });
    logger.info(`Apple sign-in: new user created username=${username}`);
  } else {
    if (user.isBanned) throw new ApiError(403, `Account suspended: ${user.banReason || 'Policy violation'}`);
    logger.info(`Apple sign-in: existing user ${user._id}`);
  }

  const accessToken  = signAccess(user._id);
  const refreshToken = signRefresh(user._id);

  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  return ApiResponse.success(
    res,
    { user, accessToken, refreshToken },
    isNew ? 'Account created with Apple' : 'Logged in with Apple'
  );
});

module.exports = { register, login, refresh, logout, verifyEmail, forgotPassword, resetPassword, googleAuth, appleAuth };
