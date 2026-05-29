'use strict';

const User     = require('../models/User');
const Listing  = require('../models/Listing');
const ApiResponse  = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate     = require('../utils/paginate');

const getRedis = () => {
  try { return require('../config/redis').getRedisClient(); } catch { return null; }
};
const cacheGet = async (key) => {
  const r = getRedis(); if (!r) return null;
  try { const v = await r.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
};
const cacheSet = async (key, data, ttl) => {
  const r = getRedis(); if (!r) return;
  try { await r.set(key, JSON.stringify(data), 'EX', ttl); } catch { /* non-fatal */ }
};

const normalizeListing = (l) => {
  if (!l) return l;
  l.price        = (l.price        ?? 0) / 100;
  l.platformFee  = (l.platformFee  ?? 0) / 100;
  l.escrowAmount = (l.escrowAmount ?? 0) / 100;
  return l;
};

/**
 * GET /api/search/users?q=:username&limit=20
 * Returns tipsters whose username matches the query (case-insensitive prefix).
 * Empty q returns top tipsters by win rate — used for the "discover" state.
 */
const searchUsers = asyncHandler(async (req, res) => {
  const q     = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const cacheKey = `search:users:${q}:${limit}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return ApiResponse.success(res, cached);

  const filter = { isTipster: true, isBanned: false };
  // Prefix regex (^) uses the existing B-tree index on username — much faster than substring match
  if (q) filter.username = { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' };

  const users = (await User.find(filter)
    .sort({ 'metrics.winRate': -1, 'metrics.totalListings': -1 })
    .limit(limit)
    .lean())
    .map((u) => {
      const { passwordHash, refreshToken, emailVerificationToken,
              passwordResetToken, passwordResetExpires, kycData, ...safe } = u;
      return safe; // followersCount is now a real field on the document
    });

  const payload = { users };
  await cacheSet(cacheKey, payload, 120); // 2 min
  return ApiResponse.success(res, payload);
});

/**
 * GET /api/search/listings?q=&platform=&sport=&isLive=&date=&page=&limit=
 * Filters active listings. All params optional — returns all active listings when none supplied.
 * q: text search by tipster username.
 * date format: YYYY-MM-DD — filters kickoffTime to that calendar day (UTC).
 */
const searchListings = asyncHandler(async (req, res) => {
  const { platform, sport, isLive, date } = req.query;
  const q     = (req.query.q || '').trim();
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const cacheKey = `search:listings:${q}:${platform || ''}:${sport || ''}:${isLive || ''}:${date || ''}:${page}:${limit}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return ApiResponse.success(res, cached);

  const filter = { status: 'active' };
  if (platform) filter.platform = platform;
  if (sport)    filter.sport    = sport;
  if (isLive === 'true' || isLive === 'false') filter.isLive = isLive === 'true';

  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tipsterIds = (await User.find({ username: { $regex: `^${escaped}`, $options: 'i' }, isTipster: true })
      .select('_id').lean()).map((u) => u._id);
    filter.tipster = { $in: tipsterIds };
  }

  if (date) {
    const start = new Date(date);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setUTCHours(23, 59, 59, 999);
    filter.kickoffTime = { $gte: start, $lte: end };
  }

  const skip = (page - 1) * limit;
  const [total, rawListings] = await Promise.all([
    Listing.countDocuments(filter),
    Listing.find(filter).sort({ isLive: -1, createdAt: -1 }).skip(skip).limit(limit)
      .populate('tipster', 'username profilePhoto metrics isTipster')
      .select('-bettingCode -trackedMatches').lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  const payload = { listings: rawListings.map(normalizeListing), pagination };
  await cacheSet(cacheKey, payload, 60); // 1 min — listings change frequently
  return ApiResponse.success(res, payload);
});

module.exports = { searchUsers, searchListings };
