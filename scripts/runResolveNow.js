'use strict';

// Local-only: bypass TLS cert validation (antivirus intercepts certs on this machine)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Use Google DNS so the mongodb+srv SRV lookup works (local DNS can't resolve SRV)
require('dns').setServers(['8.8.8.8', '8.8.4.4']);

require('dotenv').config();
const mongoose = require('mongoose');

// Inline the resolve logic so we don't register any cron jobs
const Listing  = require('../src/models/Listing');
const Purchase = require('../src/models/Purchase');
const { getFixtureResult, getMatchStatistics, resolveSelection } = require('../src/services/apiFootball.service');
const { releaseToTipster, refundToBuyer } = require('../src/services/escrow.service');
const { recalculateAnalytics }            = require('../src/services/analytics.service');

const processListing = async (listing) => {
  const now   = new Date();
  const fresh = await Listing.findById(listing._id);
  if (!fresh) return;
  // Allow processing of migration listings (allMatchesResolved: true but pending matches remain)

  const alreadySettled = fresh.status === 'won' || fresh.status === 'lost';

  let modified    = false;
  let allResolved = true;
  let hasLoss     = false;

  for (let i = 0; i < fresh.trackedMatches.length; i++) {
    const match = fresh.trackedMatches[i];

    if (match.result !== 'pending') {
      if (match.result === 'lost') hasLoss = true;
      continue;
    }

    if (new Date(match.kickoffTime) > now) { allResolved = false; continue; }

    const apiResult = await getFixtureResult(match.fixtureId, match.sport || 'football');
    if (!apiResult || !apiResult.isFinished) { allResolved = false; continue; }

    let outcome = resolveSelection(match.selection, apiResult);
    if (outcome === 'unresolvable') {
      const stats = await getMatchStatistics(match.fixtureId);
      if (stats) outcome = resolveSelection(match.selection, apiResult, stats);
    }

    if (outcome === 'unresolvable') {
      console.log(`  [skip] selection '${match.selection}' not auto-resolvable`);
      fresh.autoResolvable = false;
      allResolved = false;
      modified = true;
      continue;
    }

    fresh.trackedMatches[i].result     = outcome;
    fresh.trackedMatches[i].resolvedAt = new Date();
    modified = true;
    console.log(`  fixture ${match.fixtureId} → ${outcome}`);

    if (outcome === 'lost') hasLoss = true;
    // No break — resolve all for display
  }

  if (modified) fresh.markModified('trackedMatches');

  if (allResolved) fresh.allMatchesResolved = true;

  const listingWon   = !hasLoss;
  const shouldSettle = !alreadySettled && (hasLoss || allResolved);
  if (shouldSettle) fresh.status = listingWon ? 'won' : 'lost';

  await fresh.save();

  if (shouldSettle) {
    const purchases = await Purchase.find({ listing: fresh._id, status: 'active' }).select('_id').lean();
    const settle = listingWon ? releaseToTipster : refundToBuyer;
    await Promise.allSettled(purchases.map((p) => settle(p._id.toString()).catch(console.error)));
    console.log(`  → settled ${purchases.length} purchases as ${listingWon ? 'WON' : 'LOST'}`);

    recalculateAnalytics(fresh.tipster.toString()).catch(() => {});
  }
};

(async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000, tlsInsecure: true });
  console.log('Connected.\n');

  const now = new Date();

  // Pass 1 — normal: listings not yet fully resolved
  const pending = await Listing.find({
    listingType:        'tracked',
    autoResolvable:     true,
    allMatchesResolved: false,
    'trackedMatches.kickoffTime': { $lte: now },
  }).lean();

  // Pass 2 — migration: listings already settled by old code but with display-pending matches
  const stalePending = await Listing.find({
    listingType:        'tracked',
    allMatchesResolved: true,
    status:             { $in: ['won', 'lost'] },
    'trackedMatches.result':      'pending',
    'trackedMatches.kickoffTime': { $lte: now },
  }).lean();

  const listings = [...pending, ...stalePending];
  console.log(`Found ${listings.length} listing(s) to process (${pending.length} normal, ${stalePending.length} migration).\n`);

  for (const listing of listings) {
    console.log(`Processing listing ${listing._id}...`);
    try {
      await processListing(listing);
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
    }
  }

  console.log('\nAll done.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
