/**
 * models/TipsterAnalytics.js — Full analytics record for a single tipster.
 * Populated by analytics.service.js after every listing resolution.
 * Powers the leaderboard, tipster profile stats, and PnL charts.
 */

'use strict';

const mongoose = require('mongoose');

const badgeSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['Pro', 'Elite', 'Consistent', 'Sharp', 'Reliable', 'Comeback', 'Legend'],
    required: true,
  },
  awardedAt: { type: Date, default: Date.now },
  description: { type: String },
}, { _id: false });

const weeklySnapshotSchema = new mongoose.Schema({
  weekStart: { type: Date, required: true },
  wins:      { type: Number, default: 0 },
  losses:    { type: Number, default: 0 },
  pnl:       { type: Number, default: 0 },
  winRate:   { type: Number, default: 0 },
  avgOdds:   { type: Number, default: 0 },
}, { _id: false });

const tipsterAnalyticsSchema = new mongoose.Schema({
  tipster: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
    index: true,
  },

  // ── Core metrics ────────────────────────────────────────────────────────────
  totalListings:     { type: Number, default: 0 },
  totalFreeListings: { type: Number, default: 0 },
  totalPaidListings: { type: Number, default: 0 },
  totalWins:         { type: Number, default: 0 },
  totalLosses:       { type: Number, default: 0 },
  totalDisputes:     { type: Number, default: 0 },
  winRate:           { type: Number, default: 0 }, // percentage, always recalculated

  // ── Odds metrics ────────────────────────────────────────────────────────────
  averageOdds: { type: Number, default: 0 },
  highestOdds: { type: Number, default: 0 },
  lowestOdds:  { type: Number, default: 0 },

  // ── Profit/Loss simulation ───────────────────────────────────────────────────
  // If a buyer bought every paid tip:
  //   Win = +₦1,000 | Loss = -₦1,100
  simulatedPnL:    { type: Number, default: 0 }, // all-time
  simulatedPnL7d:  { type: Number, default: 0 }, // last 7 days
  simulatedPnL30d: { type: Number, default: 0 }, // last 30 days
  simulatedPnL90d: { type: Number, default: 0 }, // last 90 days
  simulatedROI:    { type: Number, default: 0 }, // (pnl / totalSpent) * 100

  // ── Consistency score (0-100) ────────────────────────────────────────────────
  // Formula: (winRate * 0.4) + streakScore + volumeScore + trustScore
  consistencyScore: { type: Number, default: 0 },

  // ── Streak data ─────────────────────────────────────────────────────────────
  currentStreak:      { type: Number, default: 0 },
  longestWinStreak:   { type: Number, default: 0 },
  longestLossStreak:  { type: Number, default: 0 },
  currentStreakType:  { type: String, enum: ['win', 'loss', 'none'], default: 'none' },

  // ── Badge system ─────────────────────────────────────────────────────────────
  badges: { type: [badgeSchema], default: [] },

  // ── Leaderboard scores ───────────────────────────────────────────────────────
  weeklyScore:  { type: Number, default: 0 }, // recalculated every Monday midnight
  monthlyScore: { type: Number, default: 0 }, // recalculated every 1st of month
  allTimeScore: { type: Number, default: 0 }, // cumulative

  // ── Weekly snapshots for PnL chart (up to 52 weeks) ─────────────────────────
  weeklySnapshots: { type: [weeklySnapshotSchema], default: [] },

  lastCalculatedAt: { type: Date, default: Date.now },
  updatedAt:        { type: Date, default: Date.now },
}, {
  timestamps: false,
  toJSON: { virtuals: true },
});

// Indexes for leaderboard queries
tipsterAnalyticsSchema.index({ weeklyScore:  -1 });
tipsterAnalyticsSchema.index({ monthlyScore: -1 });
tipsterAnalyticsSchema.index({ allTimeScore: -1 });
tipsterAnalyticsSchema.index({ winRate:      -1 });

module.exports = mongoose.model('TipsterAnalytics', tipsterAnalyticsSchema);
