/**
 * jobs/resolveExpired.job.js — Listing lifecycle status manager.
 * Runs every 5 minutes.
 *
 * Pass 1: active listings past kickoffTime → status: locked
 * Pass 2: locked listings past outcomeWindowOpensAt (kickoffTime + 90min) → outcome_pending
 *         Sends outcome_required notification to buyers and tipster
 */

'use strict';

const cron = require('node-cron');
const Listing  = require('../models/Listing');
const Purchase = require('../models/Purchase');
const notificationService = require('../services/notification.service');
const logger = require('../utils/logger');

/**
 * Updates active listings whose kickoffTime has passed to 'locked'.
 * For tracked multi-game slips, locks only after the LAST match kicks off
 * (derived as closingTime - 3h, since closingTime = latestKickoff + 3h).
 */
const lockStartedListings = async () => {
  const now = new Date();
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

  // Manual listings: lock at first kickoff (kickoffTime = earliest match)
  const manualResult = await Listing.updateMany(
    { status: 'active', listingType: { $ne: 'tracked' }, kickoffTime: { $lte: now } },
    { $set: { status: 'locked' } }
  );

  // Tracked listings: lock only when all matches have kicked off
  // closingTime = latestKickoff + 3h → latestKickoff <= now ⟺ closingTime <= now + 3h
  const trackedResult = await Listing.updateMany(
    {
      status: 'active',
      listingType: 'tracked',
      closingTime: { $lte: new Date(now.getTime() + THREE_HOURS_MS), $ne: null },
    },
    { $set: { status: 'locked' } }
  );

  const total = (manualResult.modifiedCount ?? 0) + (trackedResult.modifiedCount ?? 0);
  if (total > 0) {
    logger.info(`resolveExpired: locked ${total} listings (${manualResult.modifiedCount} manual, ${trackedResult.modifiedCount} tracked)`);
  }
};

/**
 * Moves locked listings whose outcomeWindowOpensAt has passed to 'outcome_pending'.
 * Sends outcome_required notifications to all buyers and the tipster.
 */
const moveToPendingOutcome = async () => {
  const now = new Date();

  // Find locked listings where the 90-minute window has opened.
  // Exclude tracked listings — autoResolveTracked.job handles those automatically.
  const listings = await Listing.find({
    status: 'locked',
    outcomeWindowOpensAt: { $lte: now, $ne: null },
    autoResolvable: { $ne: true },
  }).lean();

  if (!listings.length) return;

  const listingIds = listings.map((l) => l._id);

  await Listing.updateMany(
    { _id: { $in: listingIds } },
    { $set: { status: 'outcome_pending' } }
  );

  logger.info(`resolveExpired: moved ${listings.length} listings to outcome_pending`);

  for (const listing of listings) {
    try {
      const purchases = await Purchase.find({
        listing: listing._id,
        status: 'active',
      }).select('buyer');

      const buyerNotifications = purchases.map((p) =>
        notificationService.sendInApp(
          p.buyer.toString(),
          'outcome_required',
          '⏳ Outcome pending',
          `The game for listing ${listing._id} has concluded. The outcome is being determined and your escrow will be settled shortly.`,
          { relatedListing: listing._id }
        )
      );

      const tipsterNotification = notificationService.sendInApp(
        listing.tipster.toString(),
        'outcome_required',
        '⏳ Outcome pending',
        `90 minutes have passed since your listing kickoff. The outcome is being reviewed and your earnings will be released once settled.`,
        { relatedListing: listing._id }
      );

      await Promise.allSettled([...buyerNotifications, tipsterNotification]);
    } catch (err) {
      logger.error(`resolveExpired: notification error for listing ${listing._id}:`, err);
    }
  }
};

// Schedule: every 5 minutes
cron.schedule('*/5 * * * *', async () => {
  logger.debug('Running resolveExpired job');
  try {
    await lockStartedListings();
    await moveToPendingOutcome();
  } catch (err) {
    logger.error('resolveExpired job error:', err);
  }
});

logger.info('resolveExpired cron job registered (every 5 minutes)');
