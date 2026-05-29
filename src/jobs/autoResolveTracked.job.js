/**
 * jobs/autoResolveTracked.job.js — Auto-resolves tracked listings via API-Football.
 * Runs every 10 minutes.
 *
 * For each tracked listing with unresolved matches whose kickoffTime has passed:
 *   1. Query API-Football for the fixture result
 *   2. Resolve the selection (won/lost/void)
 *   3. If ALL matches are resolved: determine listing outcome and settle all purchases
 *   4. Tracked listings: no dispute possible — result is from official API
 */

'use strict';

const cron    = require('node-cron');
const Listing = require('../models/Listing');
const Purchase = require('../models/Purchase');
const notificationService  = require('../services/notification.service');
const { getFixtureResult, getMatchStatistics, resolveSelection } = require('../services/apiFootball.service');
const { releaseToTipster, refundToBuyer }    = require('../services/escrow.service');
const { recalculateAnalytics }               = require('../services/analytics.service');
const logger = require('../utils/logger');

/**
 * Processes all tracked listings that have kickoffs in the past.
 * Called every 10 minutes by the cron schedule.
 */
const runAutoResolve = async () => {
  const now = new Date();

  // Find tracked listings with at least one unresolved match whose kickoff has passed
  const listings = await Listing.find({
    listingType:        'tracked',
    autoResolvable:     true,
    allMatchesResolved: false,
    'trackedMatches.kickoffTime': { $lte: now },
  }).lean();

  if (!listings.length) return;

  logger.info(`autoResolveTracked: processing ${listings.length} listings`);

  for (const listing of listings) {
    try {
      await processListing(listing, now);
    } catch (err) {
      logger.error(`autoResolveTracked: error processing listing ${listing._id}:`, err);
    }
  }
};

const processListing = async (listing, now) => {
  // Re-fetch to get latest match states (avoid stale lean data from bulk find)
  const fresh = await Listing.findById(listing._id);
  if (!fresh || fresh.allMatchesResolved) return;

  let modified   = false;
  let allResolved = true;
  let listingWon  = true;
  let earlyLoss   = false; // any confirmed loss busts the accumulator immediately

  for (let i = 0; i < fresh.trackedMatches.length; i++) {
    const match = fresh.trackedMatches[i];

    // Already resolved — if it lost, the slip is bust right now
    if (match.result !== 'pending') {
      if (match.result === 'lost') {
        listingWon = false;
        earlyLoss  = true;
        break; // no need to check remaining games
      }
      continue;
    }

    // Not past kickoff yet — leave pending
    if (new Date(match.kickoffTime) > now) {
      allResolved = false;
      continue;
    }

    // Fetch result from the correct sport API
    const apiResult = await getFixtureResult(match.fixtureId, match.sport || 'football');

    if (!apiResult || !apiResult.isFinished) {
      allResolved = false;
      continue;
    }

    // First attempt without stats — handles all non-corners/cards selections
    let outcome = resolveSelection(match.selection, apiResult);

    // If unresolvable (corners or cards), try fetching match statistics
    if (outcome === 'unresolvable') {
      const stats = await getMatchStatistics(match.fixtureId);
      if (stats) outcome = resolveSelection(match.selection, apiResult, stats);
    }

    if (outcome === 'unresolvable') {
      logger.warn(
        `autoResolveTracked: selection '${match.selection}' not auto-resolvable ` +
        `(listing ${listing._id}) — skipping match`,
      );
      fresh.autoResolvable = false;
      allResolved = false;
      modified = true;
      continue;
    }

    fresh.trackedMatches[i].result     = outcome;
    fresh.trackedMatches[i].resolvedAt = new Date();
    modified = true;

    logger.info(`autoResolveTracked: fixture ${match.fixtureId} → ${outcome} (listing ${listing._id})`);

    // Slip is an accumulator — one loss ends it immediately
    if (outcome === 'lost') {
      listingWon = false;
      earlyLoss  = true;
      break;
    }
  }

  // Only do the pending-check scan when no early loss was found
  if (!earlyLoss) {
    for (const m of fresh.trackedMatches) {
      if (m.result === 'pending') { allResolved = false; break; }
    }
  }

  if (modified) fresh.markModified('trackedMatches');

  const shouldSettle = earlyLoss || allResolved;

  if (shouldSettle) {
    fresh.allMatchesResolved = true;
    fresh.status = listingWon ? 'won' : 'lost';
  }

  await fresh.save();

  if (shouldSettle) {
    await settleListingPurchases(fresh, listingWon);
    recalculateAnalytics(fresh.tipster.toString()).catch((err) =>
      logger.error(`autoResolveTracked: analytics recalc failed for tipster ${fresh.tipster}:`, err),
    );
  }
};

const settleListingPurchases = async (listing, won) => {
  const purchases = await Purchase.find({
    listing: listing._id,
    status:  'active',
  }).select('_id buyer').lean();

  if (!purchases.length) {
    logger.info(`autoResolveTracked: listing ${listing._id} resolved with no active purchases`);
    return;
  }

  const settle = won ? releaseToTipster : refundToBuyer;
  const outcomeLabel = won ? 'won' : 'lost';

  await Promise.allSettled(
    purchases.map((p) =>
      settle(p._id.toString()).catch((err) =>
        logger.error(
          `autoResolveTracked: settlement failed for purchase ${p._id}:`, err,
        ),
      ),
    ),
  );

  // Notify tipster of overall outcome
  notificationService.sendInApp(
    listing.tipster.toString(),
    `tracked_listing_${outcomeLabel}`,
    won ? '🏆 Your tracked slip won!' : '📉 Your tracked slip lost',
    won
      ? `All matches on your slip won! Your listing has been marked won and earnings released.`
      : `A match on your slip lost — your listing has been settled as lost and buyers refunded.`,
    { relatedListing: listing._id },
  ).catch(() => {});

  logger.info(
    `autoResolveTracked: settled ${purchases.length} purchases for listing ${listing._id} → ${outcomeLabel}`,
  );
};

// Schedule: every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  try {
    await runAutoResolve();
  } catch (err) {
    logger.error('autoResolveTracked: unhandled error:', err);
  }
});

logger.info('autoResolveTracked cron job registered (every 10 minutes)');

module.exports = { runAutoResolve };
