/**
 * models/Notification.js — In-app notification records.
 * Created by notification.service.js and emitted via Socket.io in real time.
 */

'use strict';

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  type: {
    type: String,
    enum: [
      'new_listing',
      'listing_purchased',
      'slip_purchased',
      'outcome_required',
      'purchase_won',
      'purchase_refunded',
      'dispute_opened',
      'dispute_resolved',
      'withdrawal_success',
      'withdrawal_failed',
      'new_follower',
      'new_like',
      'new_comment',
      'evidence_requested',
      'kyc_approved',
      'kyc_rejected',
      'account_flagged',
    ],
    required: true,
  },
  title: { type: String, required: true },
  body:  { type: String, required: true },

  relatedListing:  { type: mongoose.Schema.Types.ObjectId, ref: 'Listing',  default: null },
  relatedPurchase: { type: mongoose.Schema.Types.ObjectId, ref: 'Purchase', default: null },

  isRead: { type: Boolean, default: false, index: true },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// ── Indexes ────────────────────────────────────────────────────────────────
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
