'use strict';

const mongoose = require('mongoose');

const complaintSchema = new mongoose.Schema({
  reporter: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  targetType: {
    type: String,
    enum: ['user', 'listing'],
    required: true,
  },
  targetId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true,
  },
  reason: {
    type: String,
    enum: ['fake_tip', 'misleading_odds', 'harassment', 'fraud', 'spam', 'other'],
    required: true,
  },
  description: {
    type: String,
    maxlength: 1000,
    required: true,
  },
  status: {
    type: String,
    enum: ['pending', 'under_review', 'resolved', 'dismissed'],
    default: 'pending',
    index: true,
  },
  adminNote: { type: String, default: null },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  resolvedAt: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

complaintSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Complaint', complaintSchema);
