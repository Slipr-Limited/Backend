/**
 * controllers/analytics.controller.js — Analytics and leaderboard handlers.
 *
 * Endpoints served:
 *   GET /api/analytics/tipster/:id          — full analytics for one tipster
 *   GET /api/analytics/tipster/:id/pnl-chart — weekly snapshot array for charts
 *   GET /api/analytics/leaderboard/weekly   — top 10 by weeklyScore
 *   GET /api/analytics/leaderboard/monthly  — top 10 by monthlyScore
 *   GET /api/analytics/leaderboard/alltime  — top 10 by allTimeScore
 *
 * All leaderboard routes are cached in Redis.
 */

'use strict';

const TipsterAnalytics = require('../models/TipsterAnalytics');
const Listing          = require('../models/Listing');
const ApiResponse      = require('../utils/ApiResponse');
const ApiError         = require('../utils/ApiError');
const asyncHandler     = require('../utils/asyncHandler');
const logger           = require('../utils/logger');

// ── Cache helpers (lazy Redis — safe before boot completes) ──────────────────

const getRedis = () => {
  try { return require('../config/redis').getRedisClient(); } catch { return null; }
};

const cacheGet = async (key) => {
  const r = getRedis();
  if (!r) return null;
  try {
    const val = await r.get(key);
    return val ? JSON.parse(val) : null;
  } catch {
    return null;
  }
};

const cacheSet = async (key, data, ttlSeconds) => {
  const r = getRedis();
  if (!r) return;
  try {
    await r.set(key, JSON.stringify(data), 'EX', ttlSeconds);
  } catch { /* non-fatal */ }
};

// ── Leaderboard population spec ───────────────────────────────────────────────

const LEADERBOARD_POPULATE = {
  path: 'tipster',
  select: 'username profilePhoto isTipster metrics',
};

const TOP = 10;

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/analytics/tipster/:id
 * Returns full TipsterAnalytics document. Public — no auth needed.
 * Cached 5 minutes in Redis.
 */
const getTipsterAnalytics = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `analytics:tipster:${id}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Analytics retrieved');

  let analytics = await TipsterAnalytics.findOne({ tipster: id })
    .populate(LEADERBOARD_POPULATE)
    .lean();

  if (!analytics) {
    // Tipster exists but has no resolved listings yet — return zeroed defaults
    analytics = {
      tipster: id,
      totalListings: 0, totalFreeListings: 0, totalPaidListings: 0,
      totalWins: 0, totalLosses: 0, totalDisputes: 0, winRate: 0,
      averageOdds: 0, highestOdds: 0, lowestOdds: 0,
      simulatedPnL: 0, simulatedPnL7d: 0, simulatedPnL30d: 0, simulatedPnL90d: 0, simulatedROI: 0,
      consistencyScore: 0, currentStreak: 0, longestWinStreak: 0, longestLossStreak: 0,
      currentStreakType: 'none', badges: [], weeklyScore: 0, monthlyScore: 0, allTimeScore: 0,
      weeklySnapshots: [], lastCalculatedAt: null,
    };
  }

  await cacheSet(cacheKey, analytics, 5 * 60); // 5 minutes
  return ApiResponse.success(res, analytics, 'Analytics retrieved');
});

/**
 * GET /api/analytics/tipster/:id/pnl-chart
 * Builds weekly PnL data on-the-fly from resolved listings (last 16 weeks).
 * Falls back to stored weeklySnapshots if no listings exist yet.
 * { weeks: [{ label, pnl, winRate, wins, losses, avgOdds }] }
 */
const getPnlChart = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const cacheKey = `analytics:pnlchart:${id}`;

  const cached = await cacheGet(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Chart data retrieved');

  // Build weeks on-the-fly from resolved listings — last 16 weeks
  const sixteenWeeksAgo = new Date();
  sixteenWeeksAgo.setDate(sixteenWeeksAgo.getDate() - 112);

  const listings = await Listing.find({
    tipster: id,
    status:  { $in: ['won', 'lost'] },
    kickoffTime: { $gte: sixteenWeeksAgo },
  }).select('status totalOdds kickoffTime').lean();

  // Group by ISO week (Monday-based)
  const weekMap = new Map();
  for (const l of listings) {
    const d = new Date(l.kickoffTime);
    // Shift to Monday: getDay() 0=Sun → treat as day 6, 1=Mon → 0, etc.
    const day = (d.getDay() + 6) % 7;
    const monday = new Date(d);
    monday.setDate(d.getDate() - day);
    monday.setHours(0, 0, 0, 0);
    const key = monday.toISOString();

    if (!weekMap.has(key)) weekMap.set(key, { weekStart: monday, wins: 0, losses: 0, pnl: 0, odds: [] });
    const w = weekMap.get(key);
    if (l.status === 'won')  { w.wins++;   w.pnl += 1000; }
    else                     { w.losses++; w.pnl -= 1100; }
    if (l.totalOdds) w.odds.push(l.totalOdds);
  }

  // Sort chronologically
  const sorted = [...weekMap.values()].sort((a, b) => a.weekStart - b.weekStart);

  const weeks = sorted.map((w, i) => {
    const total   = w.wins + w.losses;
    const winRate = total ? parseFloat(((w.wins / total) * 100).toFixed(2)) : 0;
    const avgOdds = w.odds.length ? parseFloat((w.odds.reduce((a, b) => a + b, 0) / w.odds.length).toFixed(2)) : 0;
    // Short label: "May 6" style
    const label = w.weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return { label, weekStart: w.weekStart, pnl: w.pnl, winRate, wins: w.wins, losses: w.losses, avgOdds };
  });

  const data = { weeks };
  await cacheSet(cacheKey, data, 5 * 60);
  return ApiResponse.success(res, data, 'Chart data retrieved');
});

/**
 * Returns the top N tipsters sorted by a given score field.
 * Shared by all three leaderboard endpoints.
 */
const getLeaderboard = async (res, scoreField, cacheKey, ttlSeconds) => {
  const cached = await cacheGet(cacheKey);
  if (cached) return ApiResponse.success(res, cached, 'Leaderboard retrieved');

  const pnlField = scoreField === 'weeklyScore'  ? 'simulatedPnL7d'
    : scoreField === 'monthlyScore' ? 'simulatedPnL30d'
    : 'simulatedPnL';

  const results = await TipsterAnalytics.find()
    .sort({ [scoreField]: -1 })
    .limit(TOP)
    .select(`tipster winRate ${pnlField} badges currentStreak currentStreakType consistencyScore ${scoreField}`)
    .populate(LEADERBOARD_POPULATE)
    .lean();

  const data = results.map((a, i) => ({
    rank:          i + 1,
    tipster:       a.tipster,
    winRate:       a.winRate,
    pnl:           a[pnlField],
    badges:        a.badges,
    currentStreak: a.currentStreak,
    currentStreakType: a.currentStreakType,
    consistencyScore: a.consistencyScore,
    score:         a[scoreField],
  }));

  await cacheSet(cacheKey, data, ttlSeconds);
  return ApiResponse.success(res, data, 'Leaderboard retrieved');
};

/** GET /api/analytics/leaderboard/weekly — cached 10 minutes */
const getWeeklyLeaderboard = asyncHandler((req, res) =>
  getLeaderboard(res, 'weeklyScore', 'leaderboard:weekly', 10 * 60),
);

/** GET /api/analytics/leaderboard/monthly — cached 10 minutes */
const getMonthlyLeaderboard = asyncHandler((req, res) =>
  getLeaderboard(res, 'monthlyScore', 'leaderboard:monthly', 10 * 60),
);

/** GET /api/analytics/leaderboard/alltime — cached 30 minutes */
const getAllTimeLeaderboard = asyncHandler((req, res) =>
  getLeaderboard(res, 'allTimeScore', 'leaderboard:alltime', 30 * 60),
);

module.exports = {
  getTipsterAnalytics,
  getPnlChart,
  getWeeklyLeaderboard,
  getMonthlyLeaderboard,
  getAllTimeLeaderboard,
};
