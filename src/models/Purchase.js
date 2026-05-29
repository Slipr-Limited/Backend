/**
 * models/Purchase.js — Tracks every slip unlock by a buyer.
 * Escrow lifecycle: pending → active → won/refunded/disputed.
 * All amounts in KOBO.
 */

'use strict';

const mongoose = require('mongoose');

const purchaseSchema = new mongoose.Schema({
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
    index: true,
  },

  // All amounts in KOBO
  amountPaid:   { type: Number, default: 110000 }, // ₦1,100
  platformFee:  { type: Number, default: 10000  }, // ₦100
  escrowAmount: { type: Number, default: 100000 }, // ₦1,000

  paystackReference: { type: String, unique: true, sparse: true },

  status: {
    type: String,
    enum: ['pending', 'active', 'won', 'lost', 'refunded', 'disputed'],
    default: 'pending',
  },

  unlockedAt:  { type: Date, default: null }, // When payment confirmed
  resolvedAt:  { type: Date, default: null }, // When escrow settled
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  toJSON: {
    transform(_doc, ret) {
      // Convert kobo → naira for API responses
      ret.amountPaid   = ret.amountPaid   / 100;
      ret.platformFee  = ret.platformFee  / 100;
      ret.escrowAmount = ret.escrowAmount / 100;
      return ret;
    },
  },
});

// ── Indexes ────────────────────────────────────────────────────────────────
purchaseSchema.index({ buyer: 1, listing: 1 });
purchaseSchema.index({ listing: 1, status: 1 }); // tipster pending earnings lookup
// paystackReference already indexed via unique: true + sparse: true

module.exports = mongoose.model('Purchase', purchaseSchema);
