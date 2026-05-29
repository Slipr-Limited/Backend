/**
 * models/User.js — User schema.
 * Covers both Buyers (default) and Tipsters (isTipster: true).
 * KYC fields (BVN, NIN) are AES-256 encrypted before save.
 * passwordHash and refreshToken are never returned by toJSON.
 */

'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { encrypt, decrypt } = require('../utils/encrypt');

const metricsSchema = new mongoose.Schema({
  totalListings:    { type: Number, default: 0 },
  totalWins:        { type: Number, default: 0 },
  totalLosses:      { type: Number, default: 0 },
  winRate:          { type: Number, default: 0 },   // Percentage 0-100
  totalEarned:      { type: Number, default: 0 },   // In kobo
  totalPurchases:   { type: Number, default: 0 },
  currentStreak:     { type: Number, default: 0 },
  currentStreakType: { type: String, default: 'none' }, // 'win' | 'loss' | 'none'
  longestWinStreak:  { type: Number, default: 0 },
  lastPosted:       { type: Date, default: null },
  // Synced from TipsterAnalytics for quick feed-card access (no extra query)
  consistencyScore: { type: Number, default: 0 },
  simulatedPnL30d:  { type: Number, default: 0 },   // ₦ naira (not kobo)
  badges:           [{ type: String }],              // badge type strings: ['Pro', 'Sharp']
}, { _id: false });

const kycDataSchema = new mongoose.Schema({
  bvn: { type: String, default: null }, // stored encrypted
  nin: { type: String, default: null }, // stored encrypted
}, { _id: false });

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 30,
    match: [/^[a-z0-9_]+$/, 'Username may only contain letters, numbers and underscores'],
  },
  email: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email'],
  },
  phone: {
    type: String,
    trim: true,
    default: null,
  },
  passwordHash: {
    type: String,
    required: true,
    select: false, // Never returned in queries unless explicitly requested
  },
  profilePhoto:  { type: String, default: null },
  displayName:   { type: String, maxlength: 50, trim: true, default: null },
  bio:           { type: String, maxlength: 160, default: null },
  isTipster:      { type: Boolean, default: false },
  isEmailVerified:        { type: Boolean, default: false },
  emailVerificationToken: { type: String, default: null, select: false },
  passwordResetToken:     { type: String, default: null, select: false },
  passwordResetExpires:   { type: Date, default: null, select: false },

  kycStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none',
  },
  kycData: { type: kycDataSchema, default: {}, select: false }, // encrypted, never in response

  // followers/following are now stored in the Follow collection.
  // followersCount is a denormalized counter incremented/decremented on follow/unfollow.
  followersCount: { type: Number, default: 0 },
  refreshToken: { type: String, default: null, select: false },
  appleId:      { type: String, default: null, select: false, sparse: true },

  isAdmin:   { type: Boolean, default: false },
  adminRole: {
    type: String,
    enum: ['super_admin', 'finance_admin', 'support_admin', 'escrow_admin', null],
    default: null,
  },
  adminCreatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  adminCreatedAt: { type: Date, default: null },
  lastAdminLogin: { type: Date, default: null },

  isBanned:    { type: Boolean, default: false },
  banReason:   { type: String, default: null },
  isFlagged:   { type: Boolean, default: false },
  flagReasons: [{ type: String }],

  isVerified:  { type: Boolean, default: false }, // blue-tick: KYC approved + ₦25k/month revenue
  pushToken:   { type: String, default: null, select: false }, // Expo push token
  deletedAt:   { type: Date, default: null },

  verificationRequest: {
    reason:      { type: String, default: null },
    socialLink:  { type: String, default: null },
    submittedAt: { type: Date, default: null },
    status:      { type: String, enum: ['pending', 'approved', 'rejected', null], default: null },
  },

  metrics: { type: metricsSchema, default: () => ({}) },

  // Blue-tick subscription — ₦21,000/month auto-deducted from wallet
  verifiedSubscription: {
    isActive:        { type: Boolean, default: false },
    startDate:       { type: Date,    default: null },
    nextBillingDate: { type: Date,    default: null },
    cancelledAt:     { type: Date,    default: null },  // set on cancel; billing continues to end of period
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  toJSON: {
    transform(_doc, ret) {
      delete ret.passwordHash;
      delete ret.refreshToken;
      delete ret.kycData;
      delete ret.emailVerificationToken;
      delete ret.passwordResetToken;
      delete ret.passwordResetExpires;
      return ret;
    },
  },
});

// ── Indexes ────────────────────────────────────────────────────────────────
// username and email already have unique: true which creates their indexes
userSchema.index({ isTipster: 1, isBanned: 1, 'metrics.winRate': -1 });      // discover / leaderboard queries
userSchema.index({ isTipster: 1, isBanned: 1, 'metrics.totalListings': -1 }); // search sort fallback

// ── Instance methods ───────────────────────────────────────────────────────

/**
 * Compares a plaintext password against the stored hash.
 * @param {string} candidate - Plaintext password from login request
 * @returns {Promise<boolean>}
 */
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

/**
 * Encrypts and sets the BVN field in kycData.
 * @param {string} bvn - Raw BVN string
 */
userSchema.methods.setBVN = function (bvn) {
  this.kycData = this.kycData || {};
  this.kycData.bvn = encrypt(bvn);
};

/**
 * Encrypts and sets the NIN field in kycData.
 * @param {string} nin - Raw NIN string
 */
userSchema.methods.setNIN = function (nin) {
  this.kycData = this.kycData || {};
  this.kycData.nin = encrypt(nin);
};

// ── Static methods ─────────────────────────────────────────────────────────

/**
 * Hashes a plaintext password.
 * @param {string} password - Plaintext password
 * @returns {Promise<string>} bcrypt hash
 */
userSchema.statics.hashPassword = async function (password) {
  return bcrypt.hash(password, 12);
};

module.exports = mongoose.model('User', userSchema);
