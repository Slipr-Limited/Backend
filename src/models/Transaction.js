/**
 * models/Transaction.js — Immutable audit log of every wallet movement.
 * Never updated after creation — only inserted.
 * All amounts in KOBO.
 */

'use strict';

const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: [
      'deposit',        // Buyer tops up wallet via Paystack
      'purchase',       // Buyer pays ₦1,100 to unlock slip
      'platform_fee',   // ₦100 deducted as platform fee
      'escrow_hold',    // ₦1,000 moved to escrowBalance
      'escrow_release', // Buyer's escrow deducted when slip won (debit for buyer)
      'earning',        // Tipster credited after slip won (credit for tipster)
      'refund',         // ₦1,000 returned to buyer on loss
      'withdrawal',     // Tipster withdraws to bank
    ],
    required: true,
  },

  // All amounts in KOBO
  amount:        { type: Number, required: true },
  balanceBefore: { type: Number, required: true },
  balanceAfter:  { type: Number, required: true },

  reference:   { type: String, unique: true, required: true },
  description: { type: String, default: '' },

  relatedListing:  { type: mongoose.Schema.Types.ObjectId, ref: 'Listing',  default: null },
  relatedPurchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },

  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'success',
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  toJSON: {
    transform(_doc, ret) {
      ret.amount        = ret.amount        / 100;
      ret.balanceBefore = ret.balanceBefore / 100;
      ret.balanceAfter  = ret.balanceAfter  / 100;
      return ret;
    },
  },
});

// ── Indexes ────────────────────────────────────────────────────────────────
transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1, createdAt: -1 }); // admin finance aggregations
// reference already indexed via unique: true

module.exports = mongoose.model('Transaction', transactionSchema);
