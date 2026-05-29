'use strict';

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
  if (!fresh || fresh.allMatchesResolved) return;

  let modified    = false;
  let allResolved = true;
  let listingWon  = true;
  let earlyLoss   = false;

  for (let i = 0; i < fresh.trackedMatches.length; i++) {
    const match = fresh.trackedMatches[i];

    if (match.result !== 'pending') {
      if (match.result === 'lost') { listingWon = false; earlyLoss = true; break; }
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

    if (outcome === 'lost') { listingWon = false; earlyLoss = true; break; }
  }

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
    const purchases = await Purchase.find({ listing: fresh._id, status: 'active' }).select('_id').lean();
    const settle = listingWon ? releaseToTipster : refundToBuyer;
    await Promise.allSettled(purchases.map((p) => settle(p._id.toString()).catch(console.error)));
    console.log(`  → settled ${purchases.length} purchases as ${listingWon ? 'WON' : 'LOST'}`);

    recalculateAnalytics(fresh.tipster.toString()).catch(() => {});
  }
};

(async () => {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  console.log('Connected.\n');

  const now = new Date();
  const listings = await Listing.find({
    listingType:        'tracked',
    autoResolvable:     true,
    allMatchesResolved: false,
    'trackedMatches.kickoffTime': { $lte: now },
  }).lean();

  console.log(`Found ${listings.length} listing(s) to process.\n`);

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
