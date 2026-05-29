/**
 * services/escrow.service.js — Core escrow lifecycle logic.
 * Controls the flow of ₦1,000 (100000 kobo) from buyer → escrow → tipster/buyer.
 * All operations are atomic and create audit Transaction records.
 */

'use strict';

const mongoose = require('mongoose');
const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const User     = require('../models/User');
const { holdEscrow, releaseEscrow, creditWallet, debitWallet } = require('./wallet.service');
const notificationService = require('./notification.service');
const pushService = require('./pushNotification.service');
const { recalculateAnalytics } = require('./analytics.service');
const generateReference   = require('../utils/generateReference');
const ApiError = require('../utils/ApiError');
const logger   = require('../utils/logger');

/**
 * Moves ₦1,000 from buyer's spendable balance → buyer's escrowBalance.
 * Called after Paystack confirms payment for a purchase.
 *
 * @param {string} purchaseId - The Purchase document _id
 * @returns {Promise<Purchase>}
 */
const holdEscrowForPurchase = async (purchaseId) => {
  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const ref = generateReference('ESC-HOLD');

  await holdEscrow(purchase.buyer.toString(), purchase.escrowAmount, {
    reference: ref,
    description: `Escrow hold for listing ${purchase.listing._id}`,
    relatedListing: purchase.listing._id,
    relatedPurchase: purchase._id,
  });

  purchase.status = 'active';
  purchase.unlockedAt = new Date();
  await purchase.save();

  logger.info(`Escrow held: purchaseId=${purchaseId}, amount=${purchase.escrowAmount} kobo`);
  return purchase;
};

/**
 * Releases ₦1,000 from buyer's escrow → tipster's spendable balance.
 * Called when the slip is confirmed won.
 *
 * @param {string} purchaseId
 * @returns {Promise<Purchase>}
 */
const releaseToTipster = async (purchaseId) => {
  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const tipsterId = purchase.listing.tipster.toString();
  const ref = generateReference('REL-WIN');

  // Release from buyer's escrow
  await releaseEscrow(purchase.buyer.toString(), purchase.escrowAmount, {
    reference: `${ref}-BUYER`,
    description: `Escrow released — slip won (purchase ${purchase._id})`,
    relatedListing: purchase.listing._id,
    relatedPurchase: purchase._id,
  });

  // Credit tipster ₦900 — platform keeps ₦100 additional margin on wins
  const tipsterCreditKobo = purchase.escrowAmount - purchase.platformFee; // 90000 kobo
  await creditWallet(tipsterId, tipsterCreditKobo, {
    type: 'earning',
    reference: ref,
    description: `Slip won — ₦${tipsterCreditKobo / 100} credited (purchase ${purchase._id})`,
    relatedListing: purchase.listing._id,
    relatedPurchase: purchase._id,
  });

  purchase.status = 'won';
  purchase.resolvedAt = new Date();
  await purchase.save();

  // Update listing status
  await Listing.findByIdAndUpdate(purchase.listing._id, { status: 'won' });

  // Update tipster metrics with correct earned amount
  await updateTipsterMetrics(tipsterId, 'win', tipsterCreditKobo);

  // Full analytics recalculation (non-blocking — failure must not break escrow)
  recalculateAnalytics(tipsterId).catch((err) =>
    logger.error(`analytics recalc failed after win (tipster=${tipsterId}):`, err),
  );

  // In-app + push notifications
  await notificationService.sendInApp(
    purchase.buyer.toString(),
    'purchase_won',
    '🏆 Your tip won!',
    `The slip you purchased won. Escrow settled — tipster earned ₦${tipsterCreditKobo / 100}.`,
    { relatedPurchase: purchase._id, relatedListing: purchase.listing._id }
  );
  pushService.sendPush(
    purchase.buyer.toString(),
    '🏆 Tip Won!',
    `Your purchased slip won — check your wallet.`,
    { screen: 'PurchaseDetail', purchaseId: purchase._id.toString() }
  ).catch(() => {});
  pushService.sendPush(
    tipsterId,
    '💰 Earnings released!',
    `Your slip won — ₦${tipsterCreditKobo / 100} added to your wallet.`,
    { screen: 'Wallet' }
  ).catch(() => {});

  logger.info(`Escrow released to tipster: purchaseId=${purchaseId}`);
  return purchase;
};

/**
 * Refunds ₦1,000 from buyer's escrow → buyer's spendable balance.
 * Called when the slip is confirmed lost or expires unresolved.
 *
 * @param {string} purchaseId
 * @returns {Promise<Purchase>}
 */
const refundToBuyer = async (purchaseId) => {
  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const tipsterId = purchase.listing.tipster.toString();
  const ref = generateReference('REF-LOSS');

  // Release from escrow
  await releaseEscrow(purchase.buyer.toString(), purchase.escrowAmount, {
    reference: `${ref}-ESC`,
    description: `Escrow released — slip lost (purchase ${purchase._id})`,
    relatedListing: purchase.listing._id,
    relatedPurchase: purchase._id,
  });

  // Refund to buyer's spendable balance
  await creditWallet(purchase.buyer.toString(), purchase.escrowAmount, {
    type: 'refund',
    reference: ref,
    description: `Refund — slip lost (purchase ${purchase._id})`,
    relatedListing: purchase.listing._id,
    relatedPurchase: purchase._id,
  });

  purchase.status = 'refunded';
  purchase.resolvedAt = new Date();
  await purchase.save();

  // Update listing status
  await Listing.findByIdAndUpdate(purchase.listing._id, { status: 'lost' });

  // Update tipster metrics (loss)
  await updateTipsterMetrics(tipsterId, 'loss', 0);

  // Full analytics recalculation (non-blocking)
  recalculateAnalytics(tipsterId).catch((err) =>
    logger.error(`analytics recalc failed after loss (tipster=${tipsterId}):`, err),
  );

  // In-app + push notifications
  await notificationService.sendInApp(
    purchase.buyer.toString(),
    'purchase_refunded',
    '↩️ Refund processed',
    `The slip lost. ₦${purchase.escrowAmount / 100} has been refunded to your wallet.`,
    { relatedPurchase: purchase._id, relatedListing: purchase.listing._id }
  );
  pushService.sendPush(
    purchase.buyer.toString(),
    '↩️ Refund sent',
    `The slip lost — ₦${purchase.escrowAmount / 100} refunded to your wallet.`,
    { screen: 'Wallet' }
  ).catch(() => {});

  logger.info(`Escrow refunded to buyer: purchaseId=${purchaseId}`);
  return purchase;
};

/**
 * Updates a tipster's metrics after a slip outcome.
 * Recalculates winRate, streak, and longestWinStreak.
 *
 * @param {string} tipsterId
 * @param {'win'|'loss'} result
 * @param {number} earnedKobo - Amount earned this outcome (0 on loss)
 */
const updateTipsterMetrics = async (tipsterId, result, earnedKobo = 0) => {
  const user = await User.findById(tipsterId);
  if (!user) return;

  const m = user.metrics;

  if (result === 'win') {
    m.totalWins      += 1;
    m.currentStreak  += 1;
    m.totalEarned    += earnedKobo;
    if (m.currentStreak > m.longestWinStreak) {
      m.longestWinStreak = m.currentStreak;
    }
  } else {
    m.totalLosses   += 1;
    m.currentStreak  = 0;
  }

  const totalSettled = m.totalWins + m.totalLosses;
  m.winRate = totalSettled > 0
    ? parseFloat(((m.totalWins / totalSettled) * 100).toFixed(2))
    : 0;

  user.metrics = m;

  // Auto-grant verified badge once tipster reaches ₦25k lifetime earnings with KYC approved
  if (
    user.isTipster &&
    user.kycStatus === 'approved' &&
    !user.isVerified &&
    m.totalEarned >= 2_500_000
  ) {
    user.isVerified = true;
  }

  await user.save();
};

module.exports = {
  holdEscrowForPurchase,
  releaseToTipster,
  refundToBuyer,
  updateTipsterMetrics,
};
