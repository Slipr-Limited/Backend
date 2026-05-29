'use strict';

/**
 * Flutterwave webhook handler.
 *
 * Flutterwave verifies webhooks via a shared-secret header ("verif-hash").
 * express.json() body parsing is fine — no raw body needed.
 *
 * Events handled:
 *   charge.completed   → wallet_deposit, listing_purchase
 *   transfer.completed → withdrawal success / failure
 */

const crypto            = require('crypto');
const Purchase          = require('../models/Purchase');
const Listing           = require('../models/Listing');
const Transaction       = require('../models/Transaction');
const User              = require('../models/User');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const { holdEscrowForPurchase }  = require('../services/escrow.service');
const { creditWallet }           = require('../services/wallet.service');
const { verifyTransactionById }  = require('../services/flutterwave.service');
const notificationService        = require('../services/notification.service');
const pushService                = require('../services/pushNotification.service');
const generateReference          = require('../utils/generateReference');
const logger = require('../utils/logger');

// ── Signature verification ────────────────────────────────────────────────────

const verifySignature = (req) => {
  const hash   = req.headers['verif-hash'];
  const secret = process.env.FLW_WEBHOOK_HASH;
  if (!hash || !secret) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(secret));
  } catch {
    return false; // buffers differ in length
  }
};

// ── charge.completed ──────────────────────────────────────────────────────────

const handleChargeCompleted = async (data) => {
  const { id: transactionId, tx_ref: txRef, status, meta, amount: amountNaira } = data;

  if (status !== 'successful') {
    logger.debug(`webhook charge.completed ignored — status=${status} txRef=${txRef}`);
    return;
  }

  // Re-verify with Flutterwave to prevent replay / spoofed webhooks
  let verified;
  try {
    verified = await verifyTransactionById(transactionId);
  } catch (err) {
    logger.error(`webhook: FLW re-verify failed txId=${transactionId}:`, err.message);
    return;
  }

  if (verified.status !== 'successful' || verified.currency !== 'NGN') {
    logger.warn(`webhook: re-verify failed — txId=${transactionId} status=${verified.status}`);
    return;
  }

  // Idempotency: skip if this reference was already processed
  const existingTx = await Transaction.findOne({ reference: txRef });
  if (existingTx) {
    logger.debug(`webhook: duplicate charge.completed skipped — txRef=${txRef}`);
    return;
  }

  const amountKobo = Math.round(verified.amount * 100); // use re-verified amount

  if (!meta?.type) {
    logger.warn(`webhook: charge.completed with no meta.type — txRef=${txRef}`);
    return;
  }

  // ── Wallet deposit ────────────────────────────────────────────────────────
  if (meta.type === 'wallet_deposit') {
    const { userId } = meta;
    if (!userId) {
      logger.error(`webhook: wallet_deposit missing userId — txRef=${txRef}`);
      return;
    }

    // Verify the userId belongs to the account that actually paid
    const user = await User.findById(userId).select('email');
    if (!user) {
      logger.error(`webhook: wallet_deposit userId not found — userId=${userId} txRef=${txRef}`);
      return;
    }
    if (user.email.toLowerCase() !== (verified.customer?.email || '').toLowerCase()) {
      logger.error(`webhook: userId/email mismatch — userId=${userId} payer=${verified.customer?.email} txRef=${txRef}`);
      return;
    }

    await creditWallet(userId, amountKobo, {
      type:        'deposit',
      reference:   txRef,
      description: `Wallet top-up — ₦${(amountKobo / 100).toLocaleString()}`,
    });

    logger.info(`webhook wallet_deposit: userId=${userId} amount=₦${amountKobo / 100}`);
    return;
  }

  // ── Listing purchase (external payment) ───────────────────────────────────
  if (meta.type === 'listing_purchase') {
    const { purchaseId, listingId, userId } = meta;
    if (!purchaseId) {
      logger.error(`webhook: listing_purchase missing purchaseId — txRef=${txRef}`);
      return;
    }

    // Atomically claim the purchase — prevents double-credit race with verifyPurchase
    const purchase = await Purchase.findOneAndUpdate(
      { _id: purchaseId, status: 'pending' },
      { $set: { status: 'processing' } },
    );
    if (!purchase) {
      logger.debug(`webhook: purchase not found or already processing — purchaseId=${purchaseId}`);
      return;
    }

    // Credit the escrow portion into the buyer's wallet then immediately hold it
    await creditWallet(userId, purchase.escrowAmount, {
      type:            'deposit',
      reference:       `${txRef}-ESCROW-CREDIT`,
      description:     `Purchase escrow credit for listing ${listingId}`,
      relatedListing:  listingId,
      relatedPurchase: purchaseId,
    });

    await holdEscrowForPurchase(purchaseId);
    await Listing.findByIdAndUpdate(listingId, { $inc: { purchaseCount: 1 } });

    // Notify tipster of new purchase (buyer info comes from userId meta, skip if missing)
    const fullListing = await Listing.findById(listingId).select('tipster price').lean();
    if (fullListing?.tipster) {
      const amountNaira = ((purchase.amountPaid ?? 0) / 100).toLocaleString();
      notificationService.sendInApp(
        fullListing.tipster.toString(),
        'slip_purchased',
        '🛒 Someone bought your slip',
        `A new purchase of ₦${amountNaira} was made on your slip.`,
        { relatedListing: listingId, relatedPurchase: purchaseId },
      ).catch(() => {});
      pushService.sendPush(
        fullListing.tipster.toString(),
        '🛒 New slip purchase',
        `Someone just bought your slip for ₦${amountNaira}.`,
        { screen: 'SinglePost', listingId },
      ).catch(() => {});
    }

    logger.info(`webhook listing_purchase: purchaseId=${purchaseId} txRef=${txRef}`);
    return;
  }

  logger.warn(`webhook: unknown meta.type=${meta.type} — txRef=${txRef}`);
};

// ── transfer.completed ────────────────────────────────────────────────────────

const handleTransferCompleted = async (data) => {
  const { reference, status } = data;

  const withdrawal = await WithdrawalRequest.findOne({ reference });
  if (!withdrawal) {
    logger.warn(`webhook transfer.completed — no withdrawal for ref=${reference}`);
    return;
  }

  if (status === 'SUCCESSFUL') {
    if (withdrawal.status === 'success') {
      logger.debug(`webhook: transfer already success — ref=${reference}`);
      return;
    }

    withdrawal.status = 'success';
    await withdrawal.save();

    const amountNaira = (withdrawal.amount / 100).toLocaleString();
    await notificationService.sendInApp(
      withdrawal.tipster.toString(),
      'withdrawal_success',
      '💸 Withdrawal successful',
      `₦${amountNaira} has been sent to your ${withdrawal.bankName} account.`,
      {},
    );
    pushService.sendPush(
      withdrawal.tipster.toString(),
      '💸 Withdrawal successful',
      `₦${amountNaira} has been sent to your ${withdrawal.bankName} account.`,
      { screen: 'Wallet' },
    ).catch(() => {});

    logger.info(`transfer success: withdrawalId=${withdrawal._id} ref=${reference}`);
    return;
  }

  if (status === 'FAILED') {
    if (withdrawal.status !== 'processing') {
      logger.debug(`webhook transfer.failed — already in state=${withdrawal.status}`);
      return;
    }

    withdrawal.status        = 'failed';
    withdrawal.failureReason = data.complete_message || 'Bank transfer failed';
    await withdrawal.save();

    // Refund using the stored amount (more reliable than the webhook amount)
    await creditWallet(withdrawal.tipster.toString(), withdrawal.amount, {
      type:        'refund',
      reference:   generateReference('WDR-REFUND'),
      description: `Withdrawal refunded — transfer failed (${withdrawal.bankName} •••${withdrawal.accountNumber.slice(-4)})`,
    });

    const amountNaira = (withdrawal.amount / 100).toLocaleString();
    await notificationService.sendInApp(
      withdrawal.tipster.toString(),
      'withdrawal_failed',
      '❌ Withdrawal failed',
      `Your withdrawal of ₦${amountNaira} could not be completed. Funds have been returned to your wallet.`,
      {},
    );
    pushService.sendPush(
      withdrawal.tipster.toString(),
      '❌ Withdrawal failed',
      `Your withdrawal of ₦${amountNaira} failed. Funds returned to your wallet.`,
      { screen: 'Wallet' },
    ).catch(() => {});

    logger.warn(`transfer failed: withdrawalId=${withdrawal._id} ref=${reference}`);
  }
};

// ── Entry point ───────────────────────────────────────────────────────────────

const handleFlutterwaveWebhook = async (req, res) => {
  if (!verifySignature(req)) {
    logger.warn('webhook: invalid verif-hash — request rejected');
    return res.status(401).json({ success: false, message: 'Invalid signature' });
  }

  const { event, data } = req.body;

  // Respond 200 immediately — Flutterwave retries on non-2xx responses
  res.status(200).json({ success: true });

  setImmediate(async () => {
    try {
      if (event === 'charge.completed') {
        await handleChargeCompleted(data);
      } else if (event === 'transfer.completed') {
        await handleTransferCompleted(data);
      } else {
        logger.debug(`webhook: unhandled event=${event}`);
      }
    } catch (err) {
      logger.error(`webhook: uncaught error processing event=${event}:`, err);
    }
  });
};

module.exports = { handleFlutterwaveWebhook };
