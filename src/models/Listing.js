/**
 * models/Listing.js — Betting slip listing schema.
 * All monetary values (price, platformFee, escrowAmount) stored in KOBO.
 * bettingCode is hidden from the default toJSON — only returned after purchase.
 * status tracks the full lifecycle: active → locked → outcome_pending → won/lost.
 */

'use strict';

const mongoose = require('mongoose');

const listingSchema = new mongoose.Schema({
  tipster: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  platform: {
    type: String,
    enum: ['Sportybet', 'Bet9ja', '1xBet', 'BetKing', 'NairaBet', 'MerryBet', 'AccessBet'],
    required: true,
  },
  // Array so a slip can span multiple sports (e.g. football + basketball)
  sport: {
    type: [String],
    enum: ['football', 'basketball', 'tennis', 'boxing', 'others'],
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: 'At least one sport is required',
    },
  },
  numberOfGames: { type: Number, required: true, min: 1, max: 20 },
  totalOdds:     { type: Number, required: true, min: 1 },

  bettingCode: {
    type: String,
    required: true,
    // NEVER returned in toJSON — controllers add it only after verifying purchase
    select: false,
  },

  // Free tips: no payment required, code is visible to everyone immediately
  isFree: { type: Boolean, default: false },

  // All amounts in KOBO (× 100 of naira); zero for free listings
  price:         { type: Number, default: 110000, immutable: true }, // ₦1,100
  platformFee:   { type: Number, default: 10000,  immutable: true }, // ₦100
  escrowAmount:  { type: Number, default: 100000, immutable: true }, // ₦1,000

  kickoffTime: { type: Date, required: true },
  closingTime: { type: Date, required: false, default: null },

  // Set to kickoffTime + 90 minutes on creation; cron opens outcome window at this time
  outcomeWindowOpensAt: { type: Date, default: null },

  status: {
    type: String,
    enum: ['active', 'locked', 'outcome_pending', 'won', 'lost', 'expired', 'disputed', 'cancelled'],
    default: 'active',
    index: true,
  },

  // true = game is already in progress when posted; skips future-kickoff validation
  isLive: { type: Boolean, default: false },

  purchaseCount: { type: Number, default: 0 },
  description:   { type: String, maxlength: 280, default: null },

  // ── Part 2: API-Football tracked listings ─────────────────────────────────
  // manual   = tipster declares outcome; admin resolves disputes
  // tracked  = auto-resolved via API-Football results
  listingType: {
    type: String,
    enum: ['manual', 'tracked'],
    default: 'manual',
  },
  trackedMatches: [{
    fixtureId:      { type: String },   // stored as "as_<n>" or "fd_<n>"
    homeTeam:       { type: String },
    awayTeam:       { type: String },
    league:         { type: String },
    kickoffTime:    { type: Date },
    sport:          { type: String, default: 'football' }, // which API to use at resolution
    selection:      { type: String },       // '1', 'X', '2', 'over_2.5', 'home', 'away' etc.
    selectionLabel: { type: String },       // human-readable label
    odds:           { type: Number },       // odds for this specific selection
    result: {
      type: String,
      enum: ['won', 'lost', 'void', 'pending'],
      default: 'pending',
    },
    resolvedAt: { type: Date, default: null },
  }],
  autoResolvable:    { type: Boolean, default: false }, // true when all trackedMatches have fixtureId
  allMatchesResolved: { type: Boolean, default: false },

  // ── Part 3: Social engagement ─────────────────────────────────────────────
  likeCount:    { type: Number, default: 0 },
  likes:        [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  commentCount: { type: Number, default: 0 },

  // ── Part 4: Multi-platform codes (ConvertBetCodes) ─────────────────────────
  // Keyed by platform slug e.g. { sportybet: 'ABC123', bet9ja: 'XYZ', '1xbet': 'LZK' }
  platformCodes: {
    type: Map,
    of: String,
    default: {},
    select: false, // never exposed in feeds — only returned to verified buyers / tipster
  },

  // ── Part 5: Boost ──────────────────────────────────────────────────────────
  boost: {
    isActive:  { type: Boolean, default: false },
    plan:      { type: String, enum: ['1day', '3days', '7days', null], default: null },
    price:     { type: Number, default: 0 },  // kobo paid for this boost
    startDate: { type: Date,   default: null },
    endDate:   { type: Date,   default: null },
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  toJSON: {
    virtuals: true,
    transform(_doc, ret) {
      // Amounts converted from kobo to naira for API responses
      ret.price        = ret.price        / 100;
      ret.platformFee  = ret.platformFee  / 100;
      ret.escrowAmount = ret.escrowAmount / 100;
      delete ret.bettingCode; // Never leak the code — add manually in controller
      return ret;
    },
  },
});

// ── Indexes ────────────────────────────────────────────────────────────────
listingSchema.index({ status: 1, 'boost.isActive': -1, isLive: -1, createdAt: -1 }); // For You feed sort
listingSchema.index({ tipster: 1, status: 1, createdAt: -1 });      // following feed + my listings
listingSchema.index({ kickoffTime: 1, status: 1 }); // resolveExpired job
listingSchema.index({ closingTime: 1, status: 1 });
listingSchema.index({ outcomeWindowOpensAt: 1, status: 1 }); // 90-min outcome window
listingSchema.index({ listingType: 1, autoResolvable: 1, allMatchesResolved: 1 }); // autoResolveTracked job
listingSchema.index({ 'boost.isActive': 1, 'boost.endDate': 1 }); // boost expiry cron

// ── Validation ─────────────────────────────────────────────────────────────
listingSchema.pre('validate', function (next) {
  // Tracked listings: kickoffTime comes from official API, bypass the 10-min buffer requirement
  if (!this.isLive && this.listingType !== 'tracked') {
    const tenMinFromNow = new Date(Date.now() + 10 * 60 * 1000);
    if (this.kickoffTime < tenMinFromNow) {
      return next(new Error('kickoffTime must be at least 10 minutes in the future'));
    }
  }
  if (this.closingTime && this.closingTime <= this.kickoffTime) {
    return next(new Error('closingTime must be after kickoffTime'));
  }
  next();
});

module.exports = mongoose.model('Listing', listingSchema);
