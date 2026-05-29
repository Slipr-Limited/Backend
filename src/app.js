/**
 * app.js — Express application factory.
 * Registers global middleware (security, CORS, body parsing, logging),
 * mounts all API routers, and attaches the global error handler.
 */

'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const logger = require('./utils/logger');
const ApiError = require('./utils/ApiError');
const ApiResponse = require('./utils/ApiResponse');
const { globalLimiter } = require('./middleware/rateLimit.middleware');

// ── Route imports ──────────────────────────────────────────────────────────
const authRoutes         = require('./routes/auth.routes');
const userRoutes         = require('./routes/user.routes');
const listingRoutes      = require('./routes/listing.routes');
const purchaseRoutes     = require('./routes/purchase.routes');
const walletRoutes       = require('./routes/wallet.routes');
const withdrawalRoutes   = require('./routes/withdrawal.routes');
const reviewRoutes       = require('./routes/review.routes');
const disputeRoutes      = require('./routes/dispute.routes');
const notificationRoutes = require('./routes/notification.routes');
const webhookRoutes      = require('./routes/webhook.routes');
const adminRoutes        = require('./routes/admin.routes');
const searchRoutes       = require('./routes/search.routes');
const analyticsRoutes    = require('./routes/analytics.routes');
const fixturesRoutes     = require('./routes/fixtures.routes');
const socialRoutes       = require('./routes/social.routes');
const complaintRoutes        = require('./routes/complaint.routes');
const subscriptionRoutes     = require('./routes/subscription.routes');

const app = express();

// ── Compression ─────────────────────────────────────────────────────────────
app.use(compression({ threshold: 1024 })); // Gzip responses > 1KB

// ── Security headers ───────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ───────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.CLIENT_URL,
  'http://localhost:3000',
  'http://localhost:3001', // admin panel
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));

// ── Body parsing ────────────────────────────────────────────────────────────
// Flutterwave webhook verification uses a header (verif-hash), not HMAC of raw body,
// so all routes including webhooks can use standard JSON parsing.
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ── HTTP request logging (development only) ────────────────────────────────
if (process.env.NODE_ENV === 'development') {
  app.use((req, _res, next) => {
    logger.http(`${req.method} ${req.originalUrl}`);
    next();
  });
}

// ── Global rate limiter ─────────────────────────────────────────────────────
app.use(globalLimiter);

// ── Root ────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    message: 'Welcome to Slipr Backend API',
    version: '1.0.0',
    status:  'running',
  });
});

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/listings',      listingRoutes);
app.use('/api/purchases',     purchaseRoutes);
app.use('/api/wallet',        walletRoutes);
app.use('/api/withdrawals',   withdrawalRoutes);
app.use('/api/reviews',       reviewRoutes);
app.use('/api/disputes',      disputeRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/webhooks',      webhookRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/search',        searchRoutes);
app.use('/api/analytics',     analyticsRoutes);
app.use('/api/fixtures',      fixturesRoutes);
app.use('/api/listings',      socialRoutes);   // extends listing routes with social endpoints
app.use('/api/complaints',    complaintRoutes);
app.use('/api/subscriptions', subscriptionRoutes);

// ── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, _res, next) => {
  next(new ApiError(404, 'Route not found'));
});

// ── Global error handler ────────────────────────────────────────────────────
// Must have 4 parameters so Express recognises it as error middleware
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Log error with Winston
  logger.error(`${err.statusCode || 500} — ${err.message}`, {
    url: req.originalUrl,
    method: req.method,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const errors = Object.values(err.errors).map((e) => e.message);
    return ApiResponse.error(res, 'Validation failed', 422, errors);
  }

  // Mongoose cast error (bad ObjectId)
  if (err.name === 'CastError') {
    return ApiResponse.error(res, `Invalid ${err.path}: ${err.value}`, 400);
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue || {})[0] || 'field';
    return ApiResponse.error(res, `${field} already exists`, 409);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return ApiResponse.error(res, 'Invalid token', 401);
  }
  if (err.name === 'TokenExpiredError') {
    return ApiResponse.error(res, 'Token expired', 401);
  }

  // Our own ApiError
  if (err instanceof ApiError) {
    return ApiResponse.error(res, err.message, err.statusCode, err.errors);
  }

  // Unknown error — never expose details in production
  const message = process.env.NODE_ENV === 'development' ? err.message : 'Internal server error';
  return ApiResponse.error(res, message, 500);
});

module.exports = app;
