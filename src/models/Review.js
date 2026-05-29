/**
 * models/Review.js — Buyer reviews on a resolved purchase.
 * One review per purchase (enforced by unique index on purchase field).
 * Only submittable after outcome is confirmed (won or lost).
 */

'use strict';

const mongoose = require('mongoose');

const reviewSchema = new mongoose.Schema({
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  tipster: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
  },
  purchase: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Purchase',
    unique: true, // One review per purchase
    required: true,
  },
  rating: {
    type: Number,
    required: true,
    min: 1,
    max: 5,
  },
  comment: {
    type: String,
    maxlength: 500,
    trim: true,
    default: null,
  },
  outcome: {
    type: String,
    enum: ['won', 'lost'],
    required: true,
  },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// ── Indexes ────────────────────────────────────────────────────────────────
reviewSchema.index({ tipster: 1, createdAt: -1 });

module.exports = mongoose.model('Review', reviewSchema);
