/**
 * jobs/analyticsRefresh.job.js — Scheduled analytics maintenance.
 *
 * Schedule A (every Sunday midnight):   snapshotCurrentWeek for all active tipsters
 * Schedule B (every Monday midnight):   recalculate leaderboard scores for all tipsters
 * Schedule C (every 6 hours):           recalculate analytics for tipsters who posted
 *                                       in the last 24 hours (safety net)
 */

'use strict';

const cron             = require('node-cron');
const Listing          = require('../models/Listing');
const TipsterAnalytics = require('../models/TipsterAnalytics');
const {
  recalculateAnalytics,
  calculateLeaderboardScores,
  snapshotCurrentWeek,
} = require('../services/analytics.service');
const logger = require('../utils/logger');

// ── Schedule A: Sunday midnight — weekly snapshot ────────────────────────────
// Cron: 0 0 * * 0  (minute 0, hour 0, any day-of-month, any month, Sunday=0)
cron.schedule('0 0 * * 0', async () => {
  logger.info('analyticsRefresh: starting weekly snapshot job');
  try {
    // All tipsters who have at least one listing
    const tipsterIds = await TipsterAnalytics.distinct('tipster');
    await Promise.allSettled(
      tipsterIds.map((id) => snapshotCurrentWeek(id)),
    );
    logger.info(`analyticsRefresh: snapshots saved for ${tipsterIds.length} tipsters`);
  } catch (err) {
    logger.error('analyticsRefresh: weekly snapshot error:', err);
  }
});

// ── Schedule B: Monday midnight — leaderboard recalculation ─────────────────
// Cron: 0 0 * * 1  (minute 0, hour 0, any day-of-month, any month, Monday=1)
cron.schedule('0 0 * * 1', async () => {
  logger.info('analyticsRefresh: starting leaderboard recalculation');
  try {
    await calculateLeaderboardScores();
    logger.info('analyticsRefresh: leaderboard scores updated');
  } catch (err) {
    logger.error('analyticsRefresh: leaderboard recalculation error:', err);
  }
});

// ── Schedule C: every 6 hours — safety-net recalculation ────────────────────
// Cron: 0 */6 * * *  (minute 0, every 6th hour)
cron.schedule('0 */6 * * *', async () => {
  logger.info('analyticsRefresh: starting 6-hour safety-net recalculation');
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Tipsters who posted OR resolved a listing in the last 24 hours
    const [postedIds, resolvedIds] = await Promise.all([
      Listing.distinct('tipster', { createdAt: { $gte: since } }),
      // kickoffTime proxy: listings that kicked off in last 24h and are now resolved
      Listing.distinct('tipster', {
        status: { $in: ['won', 'lost'] },
        kickoffTime: { $gte: since },
      }),
    ]);

    const uniqueIds = [...new Set([
      ...postedIds.map((id) => id.toString()),
      ...resolvedIds.map((id) => id.toString()),
    ])];

    if (!uniqueIds.length) {
      logger.info('analyticsRefresh: no recent tipster activity, skipping');
      return;
    }

    await Promise.allSettled(
      uniqueIds.map((id) => recalculateAnalytics(id)),
    );
    logger.info(`analyticsRefresh: recalculated analytics for ${uniqueIds.length} tipsters`);
  } catch (err) {
    logger.error('analyticsRefresh: safety-net recalculation error:', err);
  }
});

logger.info('analyticsRefresh cron jobs registered (Sunday/Monday midnight + every 6h)');
