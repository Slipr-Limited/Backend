/**
 * jobs/autoResolveTracked.job.js — Auto-resolves tracked listings via API-Football.
 * Runs every 10 minutes.
 *
 * For each tracked listing with unresolved matches whose kickoffTime has passed:
 *   1. Query API-Football for the fixture result
 *   2. Resolve the selection (won/lost/void)
 *   3. Settle purchases as soon as any loss is detected (accumulator bust)
 *   4. Continue resolving remaining matches for display even after a loss
 *   5. allMatchesResolved = true only when every match has a final result
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

  // Normal: listings not yet fully resolved
  const normal = await Listing.find({
    listingType:        'tracked',
    autoResolvable:     true,
    allMatchesResolved: false,
    'trackedMatches.kickoffTime': { $lte: now },
  }).lean();

  // Migration: settled early by old code but still showing pending match results
  const migration = await Listing.find({
    listingType:        'tracked',
    allMatchesResolved: true,
    status:             { $in: ['won', 'lost'] },
    'trackedMatches.result':      'pending',
    'trackedMatches.kickoffTime': { $lte: now },
  }).lean();

  const listings = [...normal, ...migration];
  if (!listings.length) return;

  logger.info(`autoResolveTracked: processing ${listings.length} listings (${normal.length} normal, ${migration.length} migration)`);

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
  if (!fresh) return;
  // Migration listings have allMatchesResolved: true but pending display results — allow them through

  // Already settled (e.g. early loss on a previous run) — only resolving for display
  const alreadySettled = fresh.status === 'won' || fresh.status === 'lost';

  let modified    = false;
  let allResolved = true; // flipped to false if any match is still pending
  let hasLoss     = false;

  for (let i = 0; i < fresh.trackedMatches.length; i++) {
    const match = fresh.trackedMatches[i];

    // Already resolved — note any loss but keep going for remaining display results
    if (match.result !== 'pending') {
      if (match.result === 'lost') hasLoss = true;
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

    if (outcome === 'lost') hasLoss = true;
    // No break — continue resolving remaining matches so users see full results
  }

  if (modified) fresh.markModified('trackedMatches');

  // allMatchesResolved = true only when every match has a final result (for display completeness)
  if (allResolved) fresh.allMatchesResolved = true;

  // Settle as soon as a loss is detected OR when all matches are resolved —
  // but only once (alreadySettled guards against double-settling)
  const listingWon    = !hasLoss;
  const shouldSettle  = !alreadySettled && (hasLoss || allResolved);
  if (shouldSettle) fresh.status = listingWon ? 'won' : 'lost';

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
