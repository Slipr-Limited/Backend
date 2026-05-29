'use strict';

const Listing  = require('../models/Listing');
const Purchase = require('../models/Purchase');
const User     = require('../models/User');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const { getForYouFeed, getFollowingFeed } = require('../services/feed.service');
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

// .lean() skips toJSON transforms — convert kobo fields to naira manually.
const normalizeListing = (l) => {
  if (!l) return l;
  l.price        = (l.price        ?? 0) / 100;
  l.platformFee  = (l.platformFee  ?? 0) / 100;
  l.escrowAmount = (l.escrowAmount ?? 0) / 100;
  return l;
};

// .lean() returns Map fields as plain objects, not Map instances.
// This helper handles both so Object.fromEntries never throws.
const toPlainCodes = (v) => {
  if (!v) return {};
  if (v instanceof Map) return Object.fromEntries(v);
  return v; // already a plain object from .lean()
};

const bustFeedCache = async () => {
  try {
    const redis = getRedisClient();
    const keys  = await redis.keys('feed:foryou:*');
    if (keys.length) await redis.del(...keys);
  } catch (err) {
    logger.warn('Feed cache bust failed:', err.message);
  }
};

/**
 * POST /api/listings
 * Creates a new tracked listing — tipster only.
 * All listings go through the sports API: matches are auto-verified at resolution.
 */
const createListing = asyncHandler(async (req, res) => {
  const {
    platform, bettingCode, trackedMatches,
    description, isFree,
  } = req.body;

  if (!platform || !bettingCode) {
    throw new ApiError(400, 'platform and bettingCode are required');
  }

  if (!Array.isArray(trackedMatches) || !trackedMatches.length) {
    throw new ApiError(400, 'At least one match is required in trackedMatches');
  }

  for (const m of trackedMatches) {
    if (!m.fixtureId || !m.selection || !m.odds) {
      throw new ApiError(400, 'each match must have fixtureId, selection, and odds');
    }
  }

  const free = isFree === true || isFree === 'true';

  // Sort matches by kickoffTime so earliest is first
  const sortedMatches = [...trackedMatches].sort(
    (a, b) => new Date(a.kickoffTime) - new Date(b.kickoffTime),
  );

  const earliestKickoff = new Date(sortedMatches[0].kickoffTime);
  const latestKickoff   = new Date(sortedMatches[sortedMatches.length - 1].kickoffTime);

  // Closing = latest kickoff + 3 h; outcome window opens = latest kickoff + 105 min
  const derivedClosing       = new Date(latestKickoff.getTime() + 3 * 60 * 60 * 1000);
  const outcomeWindowOpensAt = new Date(latestKickoff.getTime() + 105 * 60 * 1000);

  // Combined odds = product of all individual match odds
  const combinedOdds = parseFloat(
    trackedMatches.reduce((acc, m) => acc * Number(m.odds), 1).toFixed(2),
  );

  // Derive sport list from the matches (each match carries its sport tag)
  const sports = [...new Set(sortedMatches.map((m) => m.sport || 'football'))];

  const priceFields = free ? { price: 0, platformFee: 0, escrowAmount: 0 } : {};

  // Store the tipster's code under their chosen platform slug.
  // API-Football handles match resolution; no third-party converter needed.
  const platformCodes = { [platform.toLowerCase()]: bettingCode };

  const listing = await Listing.create({
    tipster:        req.user._id,
    platform,
    sport:          sports,
    numberOfGames:  sortedMatches.length,
    totalOdds:      combinedOdds,
    bettingCode,
    platformCodes,
    kickoffTime:    earliestKickoff,
    closingTime:    derivedClosing,
    isLive:         false,
    isFree:         free,
    description:    description || null,
    outcomeWindowOpensAt,
    listingType:    'tracked',
    trackedMatches: sortedMatches,
    autoResolvable: true,
    allMatchesResolved: false,
    ...priceFields,
  });

  await User.findByIdAndUpdate(req.user._id, {
    $inc: { 'metrics.totalListings': 1 },
    $set: { 'metrics.lastPosted': new Date() },
  });

  bustFeedCache().catch(() => {});
  return ApiResponse.success(res, { listing }, 'Listing created', 201);
});

/**
 * GET /api/listings/feed/foryou
 */
const getForYou = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const result = await getForYouFeed(page, limit);
  return ApiResponse.success(res, result);
});

/**
 * GET /api/listings/feed/following
 */
const getFollowing = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const result = await getFollowingFeed(req.user._id.toString(), page, limit);
  return ApiResponse.success(res, result);
});

/**
 * GET /api/listings/:id
 * Returns listing details. bettingCode is included only for buyers, tipster owners, and free listings.
 * Single DB round-trip: fetch everything upfront, then strip bettingCode if not authorized.
 */
const getListing = asyncHandler(async (req, res) => {
  // Fetch listing + bettingCode in one query — strip it below if user isn't authorized
  const raw = await Listing.findById(req.params.id)
    .populate('tipster', 'username profilePhoto metrics isTipster')
    .select('+bettingCode +platformCodes')
    .lean();

  if (!raw) throw new ApiError(404, 'Listing not found');

  const listing       = normalizeListing(raw);
  const platformCodes = toPlainCodes(listing.platformCodes);
  delete listing.platformCodes; // send as a separate field for clarity

  // Free listing — everyone sees the code
  if (listing.isFree) {
    return ApiResponse.success(res, {
      listing,
      hasPurchased: false,
      bettingCode:  listing.bettingCode || null,
      platformCodes,
    });
  }

  // Paid listing — hide code by default
  delete listing.bettingCode;

  let hasPurchased = false;
  let bettingCode  = null;

  if (req.user) {
    const isTipsterOwner = listing.tipster?._id?.toString() === req.user._id.toString();

    if (isTipsterOwner) {
      // Tipster always sees their own code — fetch it minimally
      const codeDoc = await Listing.findById(req.params.id).select('+bettingCode +platformCodes -_id').lean();
      bettingCode = codeDoc?.bettingCode || null;
      hasPurchased = true;
    } else {
      // Buyer: check purchase and code in parallel
      const [purchase, codeDoc] = await Promise.all([
        Purchase.findOne({
          listing: listing._id,
          buyer:   req.user._id,
          status:  { $in: ['active', 'won', 'disputed'] },
        }).select('_id').lean(),
        // Only fetch the code doc — we'll discard if no purchase
        Listing.findById(req.params.id).select('+bettingCode -_id').lean(),
      ]);
      if (purchase) {
        hasPurchased = true;
        bettingCode  = codeDoc?.bettingCode || null;
      }
    }
  }

  return ApiResponse.success(res, { listing, hasPurchased, bettingCode, platformCodes });
});

/**
 * GET /api/listings/mine
 * Tipster's own listings.
 */
const getMyListings = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 20;
  const status = req.query.status;

  const filter = { tipster: req.user._id };
  if (status) filter.status = status;

  const skip = (page - 1) * limit;
  const [total, rawListings] = await Promise.all([
    Listing.countDocuments(filter),
    Listing.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('tipster', 'username profilePhoto metrics isTipster')
      .select('+bettingCode')
      .lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  const listings = rawListings.map((l) => {
    delete l.trackedMatches;
    return { ...normalizeListing(l), hasPurchased: true };
  });

  return ApiResponse.success(res, { listings, pagination });
});

/**
 * PATCH /api/listings/:id
 * Tipster can update description only while listing is active.
 */
const updateListing = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id);
  if (!listing) throw new ApiError(404, 'Listing not found');
  if (listing.tipster.toString() !== req.user._id.toString()) throw new ApiError(403, 'Not your listing');
  if (listing.status !== 'active') throw new ApiError(400, 'Cannot edit a listing that is no longer active');

  if (req.body.description !== undefined) {
    listing.description = req.body.description;
    await listing.save();
  }

  return ApiResponse.success(res, { listing }, 'Listing updated');
});

/**
 * DELETE /api/listings/:id
 * Tipster can cancel an active listing with zero purchases.
 */
const deleteListing = asyncHandler(async (req, res) => {
  const listing = await Listing.findById(req.params.id);
  if (!listing) throw new ApiError(404, 'Listing not found');
  if (listing.tipster.toString() !== req.user._id.toString()) throw new ApiError(403, 'Not your listing');
  if (listing.status !== 'active') throw new ApiError(400, 'Can only cancel active listings');
  if (listing.purchaseCount > 0) throw new ApiError(400, 'Cannot cancel a listing with existing purchases');

  listing.status = 'cancelled';
  await listing.save();

  await User.findByIdAndUpdate(req.user._id, { $inc: { 'metrics.totalListings': -1 } });

  return ApiResponse.success(res, null, 'Listing cancelled');
});

/**
 * GET /api/listings/tipster/:tipsterId
 * Public paginated listings for a specific tipster (no auth required).
 */
const getTipsterPublicListings = asyncHandler(async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = parseInt(req.query.limit) || 10;

  const filter = {
    tipster: req.params.tipsterId,
    status:  { $in: ['active', 'won', 'lost'] },
  };

  const skip = (page - 1) * limit;
  const [total, rawListings] = await Promise.all([
    Listing.countDocuments(filter),
    Listing.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('tipster', 'username profilePhoto metrics isTipster')
      .select('-bettingCode -trackedMatches')
      .lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return ApiResponse.success(res, { listings: rawListings.map(normalizeListing), pagination });
});

/**
 * PATCH /api/listings/:id/verdict
 * Tipster declares the outcome (won/lost) of their listing.
 * - Manual listings: tipster declares outcome after kickoff.
 * - Free listings: allowed once kickoffTime has passed (no money at stake).
 * - Tracked listings: not allowed (auto-resolved by API-Football).
 */
const submitVerdict = asyncHandler(async (req, res) => {
  const { verdict } = req.body;
  if (!['won', 'lost'].includes(verdict)) {
    throw new ApiError(400, 'verdict must be "won" or "lost"');
  }

  // Pre-check ownership and kickoff time before attempting the atomic update
  const pre = await Listing.findById(req.params.id).select('tipster listingType kickoffTime status');
  if (!pre) throw new ApiError(404, 'Listing not found');
  if (pre.tipster.toString() !== req.user._id.toString()) throw new ApiError(403, 'Not your listing');
  if (pre.listingType === 'tracked') throw new ApiError(400, 'Tracked listings are auto-resolved — no manual verdict needed');
  if (new Date() < new Date(pre.kickoffTime)) throw new ApiError(400, 'You cannot submit a verdict before the kickoff time');

  const resolvableStatuses = ['active', 'locked', 'outcome_pending'];

  // Atomically transition status — only one concurrent request wins
  const listing = await Listing.findOneAndUpdate(
    { _id: req.params.id, status: { $in: resolvableStatuses } },
    { $set: { status: verdict } },
    { new: true },
  );
  if (!listing) throw new ApiError(400, `Listing is already resolved or not in a resolvable state`);

  // Settle each active purchase through escrow service so wallet transactions + metrics fire correctly
  const { releaseToTipster, refundToBuyer } = require('../services/escrow.service');
  const { recalculateAnalytics } = require('../services/analytics.service');

  const activePurchases = await Purchase.find({ listing: listing._id, status: 'active' }).select('_id').lean();
  const settle = verdict === 'won' ? releaseToTipster : refundToBuyer;

  await Promise.allSettled(
    activePurchases.map((p) =>
      settle(p._id.toString()).catch((err) =>
        logger.error(`submitVerdict: settlement failed for purchase ${p._id}:`, err),
      ),
    ),
  );

  // Always recalculate analytics — covers free slips with zero purchases too
  recalculateAnalytics(listing.tipster.toString()).catch((err) =>
    logger.error(`submitVerdict: analytics recalc failed for tipster ${listing.tipster}:`, err),
  );

  await bustFeedCache();

  return ApiResponse.success(res, { listing }, `Result confirmed — ${verdict}`);
});

// ── Boost pricing (kobo) ───────────────────────────────────────────────────
const BOOST_PLANS = {
  '1day':  { price: 50000,  days: 1  }, // ₦500
  '3days': { price: 120000, days: 3  }, // ₦1,200
  '7days': { price: 250000, days: 7  }, // ₦2,500
};

/**
 * POST /api/listings/:id/boost
 * Body: { plan: '1day' | '3days' | '7days' }
 * Deducts the boost fee from wallet and activates the boost.
 */
const boostListing = asyncHandler(async (req, res) => {
  const { plan } = req.body;

  if (!BOOST_PLANS[plan]) {
    throw new ApiError(400, `Invalid plan. Choose one of: ${Object.keys(BOOST_PLANS).join(', ')}`);
  }

  const listing = await Listing.findById(req.params.id);
  if (!listing) throw new ApiError(404, 'Listing not found');
  if (listing.tipster.toString() !== req.user._id.toString()) throw new ApiError(403, 'Not your listing');
  if (listing.boost?.isActive) throw new ApiError(409, 'This listing is already boosted');
  if (!['active', 'locked'].includes(listing.status)) {
    throw new ApiError(400, 'Only active or locked listings can be boosted');
  }

  const { price, days } = BOOST_PLANS[plan];

  const { debitWallet } = require('../services/wallet.service');
  const generateReference = require('../utils/generateReference');

  const now     = new Date();
  const endDate = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  // Atomic debit — throws 400 if balance insufficient, prevents race conditions
  await debitWallet(req.user._id.toString(), price, {
    type:        'purchase',
    reference:   generateReference('BOOST'),
    description: `Listing boost — ${plan} plan (${days} day${days > 1 ? 's' : ''})`,
    relatedListing: req.params.id,
  });

  listing.boost = { isActive: true, plan, price, startDate: now, endDate };
  await listing.save();

  await bustFeedCache();

  logger.info(`Boost: listing ${listing._id} boosted on plan "${plan}" until ${endDate.toISOString()}`);
  return ApiResponse.success(res, {
    boost: listing.boost,
  }, `Listing boosted for ${days} day${days > 1 ? 's' : ''} — ₦${price / 100} deducted`);
});

module.exports = {
  createListing,
  getForYou,
  getFollowing,
  getListing,
  getMyListings,
  getTipsterPublicListings,
  updateListing,
  deleteListing,
  submitVerdict,
  boostListing,
  BOOST_PLANS,
};
