/**
 * jobs/flagSuspicious.job.js — Periodic fraud pattern analysis.
 * Runs every hour.
 *
 * 1. Groups purchases by buyer+tipster pair to detect collusion
 * 2. Checks new accounts for abnormal purchase volume
 * 3. Checks high-volume tipsters with zero disputes
 */

'use strict';

const cron = require('node-cron');
const Purchase = require('../models/Purchase');
const User     = require('../models/User');
const fraudService = require('../services/fraud.service');
const logger = require('../utils/logger');

// Schedule: every hour
cron.schedule('0 * * * *', async () => {
  logger.debug('Running flagSuspicious job');

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // ── Step 1: Collusion pattern check ──────────────────────────────────
    // Aggregate buyer+tipster pairs from purchases in last 7 days
    const recentPurchases = await Purchase.find({
      createdAt: { $gte: sevenDaysAgo },
    })
      .select('buyer listing')
      .populate('listing', 'tipster')
      .lean();

    // Build a map of { buyerId|tipsterId: count }
    const pairMap = {};
    for (const p of recentPurchases) {
      if (!p.listing?.tipster) continue;
      const key = `${p.buyer}|${p.listing.tipster}`;
      pairMap[key] = (pairMap[key] || 0) + 1;
    }

    // Check each pair that exceeds threshold
    for (const [key, count] of Object.entries(pairMap)) {
      if (count > 3) {
        const [buyerId, tipsterId] = key.split('|');
        await fraudService.checkCollusionPattern(buyerId, tipsterId);
      }
    }

    // ── Step 2: New account high volume ──────────────────────────────────
    const newUsers = await User.find({
      createdAt: { $gte: sevenDaysAgo },
      isAdmin: false,
    }).select('_id').lean();

    for (const u of newUsers) {
      await fraudService.checkNewAccountHighVolume(u._id.toString());
    }

    // ── Step 3: High-volume tipsters with zero disputes ──────────────────
    const highVolumeTipsters = await User.find({
      isTipster: true,
      'metrics.totalListings': { $gte: 20 },
      isFlagged: false, // Skip already-flagged users
    }).select('_id').lean();

    for (const t of highVolumeTipsters) {
      await fraudService.checkZeroDisputeHighVolume(t._id.toString());
    }

    logger.info(`flagSuspicious: processed ${Object.keys(pairMap).length} pairs, ${newUsers.length} new users, ${highVolumeTipsters.length} tipsters`);
  } catch (err) {
    logger.error('flagSuspicious job error:', err);
  }
});

logger.info('flagSuspicious cron job registered (every hour)');
