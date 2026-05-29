/**
 * services/fraud.service.js — Fraud pattern detection.
 * Called by flagSuspicious.job.js on a recurring schedule.
 * Flags accounts for admin review — does not take automatic action.
 */

'use strict';

const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const Dispute  = require('../models/Dispute');
const User     = require('../models/User');
const notificationService = require('./notification.service');
const logger = require('../utils/logger');

/**
 * Flags an account and notifies admin.
 * Appends the reason to user.flagReasons to build a history.
 *
 * @param {string} userId
 * @param {string} reason
 */
const flagAccount = async (userId, reason) => {
  try {
    await User.findByIdAndUpdate(userId, {
      isFlagged: true,
      $addToSet: { flagReasons: reason },
    });

    // Log only — admin email is not a userId and cannot be used with sendInApp
    // Admins see flagged accounts via the isFlagged filter on the admin users endpoint

    logger.warn(`Account flagged: userId=${userId}, reason=${reason}`);
  } catch (err) {
    logger.error('flagAccount error:', err);
  }
};

/**
 * Detects collusion: same buyer purchasing from the same tipster repeatedly.
 * More than 3 purchases between the same pair in 7 days is suspicious.
 *
 * @param {string} buyerId
 * @param {string} tipsterId
 */
const checkCollusionPattern = async (buyerId, tipsterId) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Get all listings by this tipster
  const tipsterListings = await Listing.find({ tipster: tipsterId }).select('_id');
  const listingIds = tipsterListings.map((l) => l._id);

  const count = await Purchase.countDocuments({
    buyer: buyerId,
    listing: { $in: listingIds },
    createdAt: { $gte: sevenDaysAgo },
  });

  if (count > 3) {
    await flagAccount(buyerId, `Collusion pattern: ${count} purchases from tipster ${tipsterId} in 7 days`);
    await flagAccount(tipsterId, `Collusion pattern: buyer ${buyerId} made ${count} purchases in 7 days`);
  }
};

/**
 * Flags new accounts that rack up too many purchases too quickly.
 * More than 5 purchases in the first 7 days of account existence is suspicious.
 *
 * @param {string} userId
 */
const checkNewAccountHighVolume = async (userId) => {
  const user = await User.findById(userId).select('createdAt');
  if (!user) return;

  const accountAge = Date.now() - new Date(user.createdAt).getTime();
  const sevenDays  = 7 * 24 * 60 * 60 * 1000;
  if (accountAge > sevenDays) return; // Only check new accounts

  const purchaseCount = await Purchase.countDocuments({ buyer: userId });
  if (purchaseCount > 5) {
    await flagAccount(userId, `New account high purchase volume: ${purchaseCount} purchases in first 7 days`);
  }
};

/**
 * Flags tipsters with high listing volume but zero disputes.
 * Everyone gets some disputes — zero is statistically anomalous and suggests fake verification.
 *
 * @param {string} tipsterId
 */
const checkZeroDisputeHighVolume = async (tipsterId) => {
  const user = await User.findById(tipsterId).select('metrics');
  if (!user || user.metrics.totalListings < 20) return;

  const tipsterListings = await Listing.find({ tipster: tipsterId }).select('_id');
  const listingIds = tipsterListings.map((l) => l._id);

  const disputeCount = await Dispute.countDocuments({
    listing: { $in: listingIds },
  });

  if (disputeCount === 0) {
    await flagAccount(
      tipsterId,
      `Zero disputes across ${user.metrics.totalListings} listings — anomalous for review`
    );
  }
};

/**
 * Detects unusual last-minute purchase surges on a listing.
 * More than 5 purchases in the 10 minutes before kickoffTime is suspicious.
 *
 * @param {string} listingId
 */
const checkLastMinuteSurge = async (listingId) => {
  const listing = await Listing.findById(listingId).select('kickoffTime tipster');
  if (!listing) return;

  const tenMinutesBefore = new Date(listing.kickoffTime.getTime() - 10 * 60 * 1000);

  const recentCount = await Purchase.countDocuments({
    listing: listingId,
    createdAt: { $gte: tenMinutesBefore },
  });

  if (recentCount > 5) {
    logger.warn(`Last-minute surge detected: listingId=${listingId}, count=${recentCount}`);
    await flagAccount(
      listing.tipster.toString(),
      `Last-minute surge: ${recentCount} purchases in 10 min before kickoff on listing ${listingId}`
    );
  }
};

module.exports = {
  flagAccount,
  checkCollusionPattern,
  checkNewAccountHighVolume,
  checkZeroDisputeHighVolume,
  checkLastMinuteSurge,
};
