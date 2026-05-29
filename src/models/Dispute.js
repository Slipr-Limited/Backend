/**
 * models/Dispute.js — Raised when either party disputes the automated verdict.
 * Resolved by admin — triggers escrow release or refund.
 */

'use strict';

const mongoose = require('mongoose');

const disputeSchema = new mongoose.Schema({
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase',
    required: true,
    index: true,
  },
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
  },
  raisedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  reason: { type: String, required: true, maxlength: 1000 },

  status: {
    type: String,
    enum: ['open', 'under_review', 'resolved_buyer', 'resolved_tipster'],
    default: 'open',
  },
  adminNote:   { type: String, default: null },
  resolvedBy:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt:  { type: Date, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// ── Indexes ────────────────────────────────────────────────────────────────
disputeSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Dispute', disputeSchema);
