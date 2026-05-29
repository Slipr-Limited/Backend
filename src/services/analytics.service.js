/**
 * services/analytics.service.js — Tipster analytics engine.
 * Calculates PnL simulation, consistency scores, streaks, badges, and leaderboard scores.
 *
 * Key exports:
 *   recalculateAnalytics(tipsterId)   — full recalc after each listing resolution
 *   calculateLeaderboardScores()      — weekly/monthly/allTime scores for all tipsters
 *   awardBadges(tipsterId, analytics) — check and award badges, notify tipster
 *   snapshotCurrentWeek(tipsterId)    — weekly snapshot for charting (called by cron)
 */

'use strict';

const Listing          = require('../models/Listing');
const User             = require('../models/User');
const TipsterAnalytics = require('../models/TipsterAnalytics');
const notificationService = require('./notification.service');
const logger           = require('../utils/logger');

// ── Helpers ─────────────────────────────────────────────────────────────────

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

const calcPnL = (listings) =>
  listings.reduce((acc, l) => {
    if (l.status === 'won')  return acc + 1000;
    if (l.status === 'lost') return acc - 1100;
    return acc;
  }, 0);

const mean = (arr) =>
  arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

/**
 * Walks resolved listings in chronological order and extracts:
 *  currentStreak, longestWinStreak, longestLossStreak, currentStreakType
 * Returns true if the Comeback badge pattern was found (5+ losses followed by 3+ wins).
 */
const computeStreaks = (sortedResolved) => {
  let longestWinStreak  = 0;
  let longestLossStreak = 0;
  let tempWin   = 0;
  let tempLoss  = 0;

  // Comeback detection state
  let bigLossHit      = false;
  let postLossWins    = 0;
  let comebackFound   = false;

  for (const l of sortedResolved) {
    if (l.status === 'won') {
      tempWin++;
      tempLoss = 0;
      if (tempWin > longestWinStreak) longestWinStreak = tempWin;
      if (bigLossHit) {
        postLossWins++;
        if (postLossWins >= 3) comebackFound = true;
      }
    } else {
      tempLoss++;
      tempWin = 0;
      if (tempLoss > longestLossStreak) longestLossStreak = tempLoss;
      if (tempLoss >= 5) bigLossHit = true;
      postLossWins = 0;
    }
  }

  // Current streak: count backwards from end
  let currentStreak     = 0;
  let currentStreakType = 'none';

  if (sortedResolved.length > 0) {
    const lastStatus = sortedResolved[sortedResolved.length - 1].status;
    currentStreakType = lastStatus === 'won' ? 'win' : 'loss';
    for (let i = sortedResolved.length - 1; i >= 0; i--) {
      if (sortedResolved[i].status === lastStatus) currentStreak++;
      else break;
    }
  }

  return { currentStreak, longestWinStreak, longestLossStreak, currentStreakType, comebackFound };
};

// ── Main: recalculateAnalytics ───────────────────────────────────────────────

/**
 * Full analytics recalculation for one tipster.
 * Called after every listing resolution and by the 6-hour safety cron.
 *
 * @param {string|ObjectId} tipsterId
 * @returns {Promise<TipsterAnalytics>}
 */
const recalculateAnalytics = async (tipsterId) => {
  const id = tipsterId.toString();

  // Fetch all listings — resolved and unresolved — for counts
  const allListings = await Listing.find({ tipster: id })
    .select('status isFree totalOdds kickoffTime')
    .lean();

  const resolvedListings = allListings.filter(
    (l) => l.status === 'won' || l.status === 'lost',
  );

  // Core counts
  const totalListings     = allListings.length;
  const totalFreeListings = allListings.filter((l) => l.isFree).length;
  const totalPaidListings = allListings.filter((l) => !l.isFree).length;
  const totalWins         = resolvedListings.filter((l) => l.status === 'won').length;
  const totalLosses       = resolvedListings.filter((l) => l.status === 'lost').length;
  const totalDisputes     = allListings.filter((l) => l.status === 'disputed').length;

  const settled = totalWins + totalLosses;
  const winRate = settled > 0
    ? parseFloat(((totalWins / settled) * 100).toFixed(2))
    : 0;

  // Odds metrics (from all resolved, ignoring zeros)
  const oddsValues = resolvedListings.map((l) => l.totalOdds).filter(Boolean);
  const averageOdds = oddsValues.length
    ? parseFloat(mean(oddsValues).toFixed(2))
    : 0;
  const highestOdds = oddsValues.length ? Math.max(...oddsValues) : 0;
  const lowestOdds  = oddsValues.length ? Math.min(...oddsValues) : 0;

  // PnL simulation — all resolved listings (free + paid).
  // "If you had bet ₦1,100 on every tip this tipster posted, win/loss would be..."
  const d7  = daysAgo(7);
  const d30 = daysAgo(30);
  const d90 = daysAgo(90);

  const simulatedPnL    = calcPnL(resolvedListings);
  const simulatedPnL7d  = calcPnL(resolvedListings.filter((l) => l.kickoffTime >= d7));
  const simulatedPnL30d = calcPnL(resolvedListings.filter((l) => l.kickoffTime >= d30));
  const simulatedPnL90d = calcPnL(resolvedListings.filter((l) => l.kickoffTime >= d90));

  const totalSpent  = resolvedListings.length * 1100;
  const simulatedROI = totalSpent > 0
    ? parseFloat(((simulatedPnL / totalSpent) * 100).toFixed(2))
    : 0;

  // Streaks — sort resolved by kickoffTime ascending
  const sortedResolved = [...resolvedListings].sort(
    (a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime),
  );
  const { currentStreak, longestWinStreak, longestLossStreak, currentStreakType, comebackFound } =
    computeStreaks(sortedResolved);

  // Consistency score (0-100)
  const winRateScore    = winRate * 0.4;                                              // 0-40
  const streakScore     = Math.min(currentStreak * 5, 20);                            // 0-20
  const volumeScore     = Math.min(totalListings / 5, 20);                            // 0-20
  const trustScore      = ((totalListings - totalDisputes) / Math.max(totalListings, 1)) * 20; // 0-20
  const consistencyScore = parseFloat((winRateScore + streakScore + volumeScore + trustScore).toFixed(2));

  // Compute leaderboard scores immediately (don't wait for weekly cron)
  const now        = new Date();
  const weekStart  = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Use all resolved listings (free + paid) so free slip wins count toward leaderboard
  const weeklyWins   = resolvedListings.filter((l) => l.kickoffTime >= weekStart && l.status === 'won').length;
  const weeklyLosses = resolvedListings.filter((l) => l.kickoffTime >= weekStart && l.status === 'lost').length;
  const monthlyWins  = resolvedListings.filter((l) => l.kickoffTime >= monthStart && l.status === 'won').length;
  const monthlyLosses = resolvedListings.filter((l) => l.kickoffTime >= monthStart && l.status === 'lost').length;

  const weeklyScore  = (weeklyWins * 10)  + (consistencyScore * 2) - (weeklyLosses * 5);
  const monthlyScore = (monthlyWins * 10) + (consistencyScore * 2) - (monthlyLosses * 5);
  const allTimeScore = (totalWins * 10)   + (consistencyScore * 5) - (totalLosses * 3);

  // Upsert analytics document
  const analytics = await TipsterAnalytics.findOneAndUpdate(
    { tipster: id },
    {
      $set: {
        tipster: id,
        totalListings,
        totalFreeListings,
        totalPaidListings,
        totalWins,
        totalLosses,
        totalDisputes,
        winRate,
        averageOdds,
        highestOdds,
        lowestOdds,
        simulatedPnL,
        simulatedPnL7d,
        simulatedPnL30d,
        simulatedPnL90d,
        simulatedROI,
        consistencyScore,
        currentStreak,
        longestWinStreak,
        longestLossStreak,
        currentStreakType,
        weeklyScore,
        monthlyScore,
        allTimeScore,
        lastCalculatedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  // Award badges first — returns the latest analytics doc with all badges applied
  const finalAnalytics = await awardBadges(id, analytics, comebackFound);

  // Sync key fields back to User.metrics for quick feed-card access (no extra query per card)
  await User.findByIdAndUpdate(id, {
    $set: {
      'metrics.totalListings':    totalListings,
      'metrics.totalWins':        totalWins,
      'metrics.totalLosses':      totalLosses,
      'metrics.winRate':          winRate,
      'metrics.currentStreak':     currentStreak,
      'metrics.currentStreakType': currentStreakType,
      'metrics.longestWinStreak':  longestWinStreak,
      'metrics.consistencyScore': consistencyScore,
      'metrics.simulatedPnL30d':  simulatedPnL30d,
      'metrics.badges':           [...new Set(finalAnalytics.badges.map((b) => b.type))],
    },
  });

  // Bust Redis cache so the next request immediately sees fresh data
  try {
    const { getRedisClient } = require('../config/redis');
    const redis = getRedisClient();
    if (redis) {
      await redis.del(`analytics:tipster:${id}`);
      await redis.del(`analytics:pnlchart:${id}`);
    }
  } catch { /* non-fatal */ }

  logger.info(`Analytics recalculated for tipster ${id}: wins=${totalWins} losses=${totalLosses} winRate=${winRate}% pnl=${simulatedPnL}`);
  return finalAnalytics;
};

// ── awardBadges ──────────────────────────────────────────────────────────────

/**
 * Checks badge conditions and awards any not already held.
 * Notifies tipster for each new badge.
 *
 * @param {string} tipsterId
 * @param {TipsterAnalytics} analytics - already-saved analytics document
 * @param {boolean} comebackFound - detected during streak calculation
 */
const awardBadges = async (tipsterId, analytics, comebackFound = false) => {
  if (!analytics) return analytics;
  const existing = new Set(analytics.badges.map((b) => b.type));
  const newBadges = [];

  const award = (type, condition, description) => {
    if (!existing.has(type) && condition) {
      newBadges.push({ type, awardedAt: new Date(), description });
    }
  };

  award('Pro',
    analytics.totalListings >= 20 && analytics.winRate >= 60,
    'Posted 20+ tips with a 60%+ win rate');

  award('Elite',
    analytics.totalListings >= 50 && analytics.winRate >= 70,
    'Posted 50+ tips with a 70%+ win rate');

  award('Consistent',
    analytics.consistencyScore >= 75,
    'Consistency score of 75 or higher');

  award('Sharp',
    analytics.averageOdds >= 5.0 && analytics.winRate >= 55,
    'Wins high-odds tips (avg 5.0+) with a 55%+ win rate');

  award('Reliable',
    analytics.longestLossStreak <= 3 && analytics.totalListings >= 30,
    '30+ tips posted with no losing streak longer than 3');

  award('Comeback',
    comebackFound,
    'Won 3+ in a row immediately after a 5-loss streak');

  // Legend requires a top-10 check — only worth querying if base conditions are met
  if (!existing.has('Legend') && analytics.totalListings >= 100 && analytics.winRate >= 65) {
    const top10 = await TipsterAnalytics.find()
      .sort({ allTimeScore: -1 })
      .limit(10)
      .select('tipster')
      .lean();

    const inTop10 = top10.some((a) => a.tipster.toString() === tipsterId);
    award('Legend',
      inTop10,
      'Top 10 all-time tipster with 100+ tips and 65%+ win rate');
  }

  if (!newBadges.length) return analytics;

  // Persist new badges — only add types not already in the array (prevents race-condition duplicates)
  const updated = await TipsterAnalytics.findOneAndUpdate(
    { tipster: tipsterId },
    [
      {
        $set: {
          badges: {
            $concatArrays: [
              '$badges',
              {
                $filter: {
                  input: newBadges,
                  as: 'nb',
                  cond: {
                    $not: { $in: ['$$nb.type', '$badges.type'] },
                  },
                },
              },
            ],
          },
        },
      },
    ],
    { new: true },
  );

  // Notify tipster for each badge earned
  await Promise.allSettled(
    newBadges.map((badge) =>
      notificationService.sendInApp(
        tipsterId,
        'badge_awarded',
        `🏅 New Badge: ${badge.type}`,
        badge.description,
        { badge: badge.type },
      ),
    ),
  );

  logger.info(`Badges awarded to tipster ${tipsterId}: ${newBadges.map((b) => b.type).join(', ')}`);
  return updated;
};

// ── calculateLeaderboardScores ───────────────────────────────────────────────

/**
 * Recalculates weekly, monthly, and all-time leaderboard scores for every tipster.
 * Uses one aggregate per period instead of N per-tipster queries.
 * Called every Monday midnight by analyticsRefresh.job.js.
 */
const calculateLeaderboardScores = async () => {
  const now        = new Date();
  const weekStart  = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // back to Sunday
  weekStart.setHours(0, 0, 0, 0);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // One aggregate each for weekly and monthly periods
  const [weeklyStats, monthlyStats] = await Promise.all([
    Listing.aggregate([
      { $match: { status: { $in: ['won', 'lost'] }, kickoffTime: { $gte: weekStart } } },
      { $group: { _id: { tipster: '$tipster', status: '$status' }, count: { $sum: 1 } } },
    ]),
    Listing.aggregate([
      { $match: { status: { $in: ['won', 'lost'] }, kickoffTime: { $gte: monthStart } } },
      { $group: { _id: { tipster: '$tipster', status: '$status' }, count: { $sum: 1 } } },
    ]),
  ]);

  // Build lookup maps: tipsterId → { wins, losses }
  const buildMap = (stats) => {
    const map = {};
    for (const { _id, count } of stats) {
      const key = _id.tipster.toString();
      if (!map[key]) map[key] = { wins: 0, losses: 0 };
      if (_id.status === 'won') map[key].wins = count;
      else map[key].losses = count;
    }
    return map;
  };

  const weeklyMap  = buildMap(weeklyStats);
  const monthlyMap = buildMap(monthlyStats);

  const allAnalytics = await TipsterAnalytics.find().lean();

  await Promise.all(
    allAnalytics.map(async (a) => {
      const key     = a.tipster.toString();
      const weekly  = weeklyMap[key]  || { wins: 0, losses: 0 };
      const monthly = monthlyMap[key] || { wins: 0, losses: 0 };

      const weeklyScore  = (weekly.wins * 10)  + (a.consistencyScore * 2) - (weekly.losses * 5);
      const monthlyScore = (monthly.wins * 10) + (a.consistencyScore * 2) - (monthly.losses * 5);
      const allTimeScore = (a.totalWins * 10)  + (a.consistencyScore * 5) - (a.totalLosses * 3);

      await TipsterAnalytics.findByIdAndUpdate(a._id, {
        $set: { weeklyScore, monthlyScore, allTimeScore, updatedAt: new Date() },
      });
    }),
  );

  logger.info('Leaderboard scores recalculated for all tipsters');
};

// ── snapshotCurrentWeek ───────────────────────────────────────────────────────

/**
 * Captures this week's stats into weeklySnapshots for chart rendering.
 * Trims snapshots older than 52 weeks to keep the array bounded.
 * Called every Sunday midnight by analyticsRefresh.job.js.
 *
 * @param {string|ObjectId} tipsterId
 */
const snapshotCurrentWeek = async (tipsterId) => {
  const id  = tipsterId.toString();
  const now = new Date();

  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay()); // Sunday
  weekStart.setHours(0, 0, 0, 0);

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  const weekListings = await Listing.find({
    tipster: id,
    status:  { $in: ['won', 'lost'] },
    kickoffTime: { $gte: weekStart, $lt: weekEnd },
  }).select('status totalOdds').lean();

  const wins   = weekListings.filter((l) => l.status === 'won').length;
  const losses = weekListings.filter((l) => l.status === 'lost').length;
  const pnl    = calcPnL(weekListings);
  const total  = wins + losses;
  const winRate = total ? parseFloat(((wins / total) * 100).toFixed(2)) : 0;
  const odds    = weekListings.map((l) => l.totalOdds).filter(Boolean);
  const avgOdds = odds.length ? parseFloat(mean(odds).toFixed(2)) : 0;

  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);

  // Push new snapshot
  await TipsterAnalytics.findOneAndUpdate(
    { tipster: id },
    { $push: { weeklySnapshots: { weekStart, wins, losses, pnl, winRate, avgOdds } } },
  );

  // Trim snapshots older than 52 weeks (separate update to avoid conflict)
  await TipsterAnalytics.findOneAndUpdate(
    { tipster: id },
    { $pull: { weeklySnapshots: { weekStart: { $lt: yearAgo } } } },
  );

  logger.info(`Weekly snapshot saved for tipster ${id}: wins=${wins} losses=${losses} pnl=${pnl}`);
};

module.exports = {
  recalculateAnalytics,
  calculateLeaderboardScores,
  awardBadges,
  snapshotCurrentWeek,
};
