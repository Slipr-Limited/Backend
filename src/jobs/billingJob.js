'use strict';

/**
 * jobs/billingJob.js — Monthly blue-tick subscription billing.
 * Runs daily at 08:00 WAT (07:00 UTC).
 *
 * For each user whose nextBillingDate is today and subscription is still active:
 *   - Attempt to deduct ₦21,000 from wallet.
 *   - Success → advance nextBillingDate by 1 month.
 *   - Failure (insufficient funds) → cancel subscription, remove blue tick.
 */

const cron   = require('node-cron');
const User   = require('../models/User');
const notificationService = require('../services/notification.service');
const { debitWallet } = require('../services/wallet.service');
const generateReference = require('../utils/generateReference');
const logger = require('../utils/logger');
const { MONTHLY_FEE } = require('../controllers/subscription.controller');

const processBilling = async () => {
  const now       = new Date();
  const todayEnd  = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  // Find active subscriptions whose billing date has arrived
  const dueUsers = await User.find({
    'verifiedSubscription.isActive':        true,
    'verifiedSubscription.nextBillingDate': { $lte: todayEnd },
  }).select('+verifiedSubscription');

  if (!dueUsers.length) {
    logger.debug('billingJob: no subscriptions due today');
    return;
  }

  logger.info(`billingJob: processing ${dueUsers.length} subscription(s)`);

  for (const user of dueUsers) {
    try {
      // Atomic debit — throws if balance insufficient, no race condition possible
      await debitWallet(user._id.toString(), MONTHLY_FEE, {
        type:        'purchase',
        reference:   generateReference('SUB-RENEW'),
        description: 'Blue-tick verified subscription renewal',
      });

      // Successful renewal — advance next billing date
      const next = new Date(user.verifiedSubscription.nextBillingDate);
      next.setMonth(next.getMonth() + 1);
      user.verifiedSubscription.nextBillingDate = next;
      await user.save({ validateBeforeSave: false });

      await notificationService.sendInApp(
        user._id.toString(),
        'subscription_renewed',
        '✅ Blue tick renewed',
        `Your verified subscription has been renewed for another month. ₦${MONTHLY_FEE / 100} deducted.`,
        {},
      ).catch(() => {});

      logger.info(`billingJob: renewed subscription for user ${user._id}`);
    } catch (err) {
      if (err.statusCode === 400 || err.message?.includes('Insufficient')) {
        // Insufficient funds — cancel and remove blue tick
        user.verifiedSubscription.isActive    = false;
        user.verifiedSubscription.cancelledAt = now;
        user.isVerified = false;
        await user.save({ validateBeforeSave: false });

        await notificationService.sendInApp(
          user._id.toString(),
          'subscription_cancelled',
          '❌ Blue tick cancelled — insufficient funds',
          `We couldn't renew your verified subscription (₦${MONTHLY_FEE / 100} needed). Top up your wallet to re-subscribe.`,
          {},
        ).catch(() => {});

        logger.warn(`billingJob: cancelled subscription for user ${user._id} — insufficient funds`);
      } else {
        logger.error(`billingJob: error processing user ${user._id}:`, err);
      }
    }
  }
};

// Run daily at 07:00 UTC (08:00 WAT)
cron.schedule('0 7 * * *', async () => {
  logger.info('billingJob: starting daily billing run');
  try {
    await processBilling();
  } catch (err) {
    logger.error('billingJob: unhandled error:', err);
  }
});

logger.info('billingJob cron registered (daily at 07:00 UTC)');
