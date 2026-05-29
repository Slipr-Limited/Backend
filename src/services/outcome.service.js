'use strict';

const Purchase = require('../models/Purchase');
const Dispute = require('../models/Dispute');
const notificationService = require('./notification.service');
const pushService         = require('./pushNotification.service');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

/**
 * Creates a Dispute document and notifies both parties and admin.
 * Sets purchase.status = 'disputed'.
 *
 * @param {string} purchaseId
 * @param {string} reason - Why the dispute was raised
 * @param {string} raisedBy - User _id who triggered the dispute (null for system)
 */
const createDispute = async (purchaseId, reason, raisedBy = null) => {
  const purchase = await Purchase.findById(purchaseId).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const existing = await Dispute.findOne({ purchase: purchaseId, status: { $ne: 'resolved_buyer' } });
  if (existing) {
    logger.warn(`Dispute already exists for purchase ${purchaseId}`);
    return existing;
  }

  const tipsterId = purchase.listing.tipster.toString();
  const buyerId   = purchase.buyer.toString();

  const dispute = await Dispute.create({
    purchase:  purchaseId,
    listing:   purchase.listing._id,
    raisedBy:  raisedBy || purchase.buyer,
    reason,
  });

  purchase.status = 'disputed';
  await purchase.save();

  await notificationService.sendInApp(
    buyerId,
    'dispute_opened',
    '⚠️ Dispute opened',
    'A dispute has been raised on your purchase. Our team will review it within 24 hours.',
    { relatedPurchase: purchase._id, relatedListing: purchase.listing._id }
  );
  pushService.sendPush(
    buyerId,
    '⚠️ Dispute opened',
    'A dispute has been raised on your purchase. Our team will review within 24 hours.',
    { screen: 'MyPurchases' },
  ).catch(() => {});

  await notificationService.sendInApp(
    tipsterId,
    'dispute_opened',
    '⚠️ Dispute opened',
    'A dispute has been raised on one of your listings. Our team will review it within 24 hours.',
    { relatedPurchase: purchase._id, relatedListing: purchase.listing._id }
  );
  pushService.sendPush(
    tipsterId,
    '⚠️ Dispute on your listing',
    'A dispute has been raised on one of your listings. Our team will review within 24 hours.',
    { screen: 'SinglePost', listingId: purchase.listing._id.toString() },
  ).catch(() => {});

  await notificationService.notifyAdminDispute(dispute._id.toString(), purchaseId);

  logger.info(`Dispute created: ${dispute._id} for purchase ${purchaseId}`);
  return dispute;
};

module.exports = { createDispute };
