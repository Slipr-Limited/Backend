/**
 * services/wallet.service.js — All wallet mutation logic.
 *
 * Every balance change goes through here so every change is:
 *   - Atomic (MongoDB findOneAndUpdate with filter guard)
 *   - Audited (Transaction document created for every operation)
 *
 * All amounts are in KOBO internally.
 */

'use strict';

const Wallet      = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const ApiError    = require('../utils/ApiError');
const generateReference = require('../utils/generateReference');

/**
 * Credits a user's spendable balance.
 * Also increments lifetime counters based on transaction type:
 *   earning  → totalEarned  (tipster earns after slip won)
 *   refund   → totalRefunded (buyer refunded after slip lost)
 */
const creditWallet = async (userId, amountKobo, txData) => {
  const inc = { balance: amountKobo };
  if (txData.type === 'earning') inc.totalEarned   = amountKobo; // tipster win payout
  if (txData.type === 'refund')  inc.totalRefunded  = amountKobo; // buyer loss refund

  const walletBefore = await Wallet.findOneAndUpdate(
    { user: userId },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );
  if (!walletBefore) throw new ApiError(404, 'Wallet not found');

  const balanceBefore = walletBefore.balance;
  const balanceAfter  = balanceBefore + amountKobo;

  await Transaction.create({
    user:            userId,
    type:            txData.type,
    amount:          amountKobo,
    balanceBefore,
    balanceAfter,
    reference:       txData.reference       || generateReference('TXN'),
    description:     txData.description     || '',
    relatedListing:  txData.relatedListing  || null,
    relatedPurchase: txData.relatedPurchase || null,
    status:          'success',
  });

  return Wallet.findOne({ user: userId });
};

/**
 * Debits a user's spendable balance.
 * Throws 400 if balance is insufficient (atomic guard prevents overdraft).
 * Also increments lifetime counters:
 *   purchase   → totalSpent
 *   withdrawal → totalWithdrawn
 */
const debitWallet = async (userId, amountKobo, txData) => {
  const inc = { balance: -amountKobo };
  if (txData.type === 'purchase')   inc.totalSpent     = amountKobo;
  if (txData.type === 'withdrawal') inc.totalWithdrawn = amountKobo;

  // The $gte guard on balance is the real concurrency lock — only one concurrent
  // request wins the update; the other gets null and throws 400.
  const walletBefore = await Wallet.findOneAndUpdate(
    { user: userId, balance: { $gte: amountKobo } },
    { $inc: inc, $set: { updatedAt: new Date() } },
  );

  if (!walletBefore) {
    const exists = await Wallet.exists({ user: userId });
    if (!exists) throw new ApiError(404, 'Wallet not found');
    const current = await Wallet.findOne({ user: userId }).select('balance');
    const available = ((current?.balance ?? 0) / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
    throw new ApiError(400, `Insufficient balance. Available: ${available}`);
  }

  const balanceBefore = walletBefore.balance;
  const balanceAfter  = balanceBefore - amountKobo;

  await Transaction.create({
    user:            userId,
    type:            txData.type,
    amount:          amountKobo,
    balanceBefore,
    balanceAfter,
    reference:       txData.reference       || generateReference('TXN'),
    description:     txData.description     || '',
    relatedListing:  txData.relatedListing  || null,
    relatedPurchase: txData.relatedPurchase || null,
    status:          'success',
  });

  return Wallet.findOne({ user: userId });
};

/**
 * Moves funds from spendable balance → escrowBalance.
 * Called after a buyer's payment is confirmed.
 */
const holdEscrow = async (userId, amountKobo, txData) => {
  const walletBefore = await Wallet.findOneAndUpdate(
    { user: userId, balance: { $gte: amountKobo } },
    { $inc: { balance: -amountKobo, escrowBalance: amountKobo }, $set: { updatedAt: new Date() } },
  );

  if (!walletBefore) {
    const exists = await Wallet.exists({ user: userId });
    if (!exists) throw new ApiError(404, 'Wallet not found');
    throw new ApiError(400, 'Insufficient balance to hold in escrow');
  }

  const balanceBefore = walletBefore.balance;

  await Transaction.create({
    user:            userId,
    type:            'escrow_hold',
    amount:          amountKobo,
    balanceBefore,
    balanceAfter:    balanceBefore - amountKobo,
    reference:       txData.reference       || generateReference('ESC'),
    description:     txData.description     || 'Escrow hold',
    relatedListing:  txData.relatedListing  || null,
    relatedPurchase: txData.relatedPurchase || null,
    status:          'success',
  });

  return Wallet.findOne({ user: userId });
};

/**
 * Releases funds from escrowBalance.
 * Does NOT credit the destination — call creditWallet separately for the recipient.
 * Used by: releaseToTipster (buyer's escrow → tipster) and refundToBuyer (buyer's escrow → buyer).
 */
const releaseEscrow = async (userId, amountKobo, txData) => {
  const walletBefore = await Wallet.findOneAndUpdate(
    { user: userId, escrowBalance: { $gte: amountKobo } },
    { $inc: { escrowBalance: -amountKobo }, $set: { updatedAt: new Date() } },
  );

  if (!walletBefore) {
    const exists = await Wallet.exists({ user: userId });
    if (!exists) throw new ApiError(404, 'Wallet not found');
    throw new ApiError(400, 'Insufficient escrow balance');
  }

  await Transaction.create({
    user:            userId,
    type:            'escrow_release',
    amount:          amountKobo,
    balanceBefore:   walletBefore.balance,
    balanceAfter:    walletBefore.balance, // spendable balance unchanged by escrow release
    reference:       txData.reference       || generateReference('REL'),
    description:     txData.description     || 'Escrow release',
    relatedListing:  txData.relatedListing  || null,
    relatedPurchase: txData.relatedPurchase || null,
    status:          'success',
  });

  return Wallet.findOne({ user: userId });
};

module.exports = { creditWallet, debitWallet, holdEscrow, releaseEscrow };
