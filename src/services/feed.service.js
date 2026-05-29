/**
 * services/feed.service.js — Listing feed queries.
 * getForYouFeed: all active listings, cached in Redis for 30s.
 * getFollowingFeed: personalised feed for a user's followed tipsters — not cached.
 * bettingCode is NEVER included — controllers must fetch it separately after purchase check.
 */

'use strict';

const Listing = require('../models/Listing');
const Follow  = require('../models/Follow');
const paginate = require('../utils/paginate');
const { getRedisClient } = require('../config/redis');
const logger = require('../utils/logger');

const FEED_CACHE_TTL = 30; // seconds
const TIPSTER_POPULATE = 'username profilePhoto metrics isTipster isVerified';

// .lean() bypasses the Listing toJSON transform — convert kobo fields to naira manually.
const normalizeListing = (l) => {
  if (!l) return l;
  l.price        = (l.price        ?? 0) / 100;
  l.platformFee  = (l.platformFee  ?? 0) / 100;
  l.escrowAmount = (l.escrowAmount ?? 0) / 100;
  return l;
};

/**
 * Returns paginated active listings for the "For You" global feed.
 * Results are cached in Redis for 30 seconds to reduce DB load.
 *
 * @param {number} page
 * @param {number} limit
 * @returns {Promise<{listings: Array, pagination: Object}>}
 */
const getForYouFeed = async (page = 1, limit = 20) => {
  const cacheKey = `feed:foryou:p${page}:l${limit}`;

  try {
    const redis = getRedisClient();
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.debug(`Feed cache hit: ${cacheKey}`);
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('Redis feed cache read failed:', err.message);
  }

  const FEED_STATUSES = ['active', 'locked'];
  const skip = (page - 1) * limit;

  // Run count and find in parallel — skip doesn't depend on totalDocs
  const [totalDocs, rawListings] = await Promise.all([
    Listing.countDocuments({ status: { $in: FEED_STATUSES } }),
    Listing.find({ status: { $in: FEED_STATUSES } })
      .sort({ 'boost.isActive': -1, isLive: -1, status: 1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('tipster', TIPSTER_POPULATE)
      .select('+bettingCode')
      .lean(),
  ]);

  const { limit: parsedLimit, ...paginationMeta } = paginate(page, limit, totalDocs);

  const now = new Date();
  const listings = rawListings.map((l) => {
      const n = normalizeListing(l);
      if (!n.isFree) n.bettingCode = undefined;
      // Expire boost if endDate has passed (edge case between cron runs)
      if (n.boost?.isActive && n.boost?.endDate && new Date(n.boost.endDate) < now) {
        n.boost.isActive = false;
      }
      return n;
    });

  const result = { listings, pagination: paginationMeta };

  // Cache the result
  try {
    const redis = getRedisClient();
    await redis.setex(cacheKey, FEED_CACHE_TTL, JSON.stringify(result));
  } catch (err) {
    logger.warn('Redis feed cache write failed:', err.message);
  }

  return result;
};

/**
 * Returns paginated listings from tipsters the user follows.
 * Personalised per user — not cached.
 *
 * @param {string} userId - The requesting user's _id
 * @param {number} page
 * @param {number} limit
 * @returns {Promise<{listings: Array, pagination: Object}>}
 */
const getFollowingFeed = async (userId, page = 1, limit = 20) => {
  // Query Follow collection — no array on User document to worry about
  const follows = await Follow.find({ follower: userId }).select('following').lean();
  if (!follows.length) {
    return { listings: [], pagination: paginate(page, limit, 0) };
  }

  const followedIds = follows.map((f) => f.following);
  const FEED_STATUSES = ['active', 'locked'];
  const followingFilter = { tipster: { $in: followedIds }, status: { $in: FEED_STATUSES } };
  const skip = (page - 1) * limit;

  // Run count and find in parallel
  const [totalDocs, rawListings] = await Promise.all([
    Listing.countDocuments(followingFilter),
    Listing.find(followingFilter)
      .sort({ 'boost.isActive': -1, isLive: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('tipster', TIPSTER_POPULATE)
      .select('+bettingCode')
      .lean(),
  ]);

  const { limit: parsedLimit, ...paginationMeta } = paginate(page, limit, totalDocs);

  const listings = rawListings.map((l) => {
      const n = normalizeListing(l);
      if (!n.isFree) n.bettingCode = undefined;
      return n;
    });

  return { listings, pagination: paginationMeta };
};

module.exports = { getForYouFeed, getFollowingFeed };
