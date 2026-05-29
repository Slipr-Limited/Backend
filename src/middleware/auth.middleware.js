/**
 * middleware/auth.middleware.js — JWT authentication guard.
 * Extracts the Bearer token, verifies it, loads the user from DB,
 * and attaches the full user document to req.user.
 * Throws 401 if token is missing, invalid, or the user is banned.
 */

'use strict';

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Protects a route — must be placed before any route handler that requires auth.
 */
const protect = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ApiError(401, 'No authentication token provided');
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    throw new ApiError(401, err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
  }

  // Fetch user — select fields not returned by default
  const user = await User.findById(decoded.id).select('+refreshToken');

  if (!user) throw new ApiError(401, 'User no longer exists');
  if (user.isBanned) throw new ApiError(403, `Account suspended: ${user.banReason || 'Policy violation'}`);

  req.user = user;
  next();
});

// Attaches user if token present, but never blocks the request.
const optionalAuth = async (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      const user = await User.findById(decoded.id);
      if (user && !user.isBanned) req.user = user;
    } catch {}
  }
  next();
};

module.exports = { protect, optionalAuth };
