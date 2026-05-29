/**
 * models/WithdrawalRequest.js — Tipster withdrawal request to a Nigerian bank.
 * KYC must be approved before a request can be created.
 * Processed via Flutterwave Transfer API. Amount stored in KOBO.
 */

'use strict';

const mongoose = require('mongoose');

const withdrawalRequestSchema = new mongoose.Schema({
  tipster: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },

  // Amount in KOBO (minimum ₦1,000 = 100,000 kobo)
  amount: { type: Number, required: true, min: 100000 },

  bankName:      { type: String, required: true },
  accountNumber: { type: String, required: true },
  accountName:   { type: String, required: true },
  bankCode:      { type: String, required: true },

  // Our internal reference (passed to Flutterwave as transfer reference)
  reference: { type: String, default: null },

  // Flutterwave transfer fields
  flwTransferId:  { type: Number, default: null },  // Flutterwave numeric transfer ID
  flwTransferRef: { type: String, default: null },  // Flutterwave's own reference (echo of ours)

  status: {
    type: String,
    enum: ['pending', 'processing', 'success', 'failed'],
    default: 'pending',
  },
  failureReason: { type: String, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  toJSON: {
    transform(_doc, ret) {
      ret.amount = ret.amount / 100; // kobo → naira for API responses
      return ret;
    },
  },
});

withdrawalRequestSchema.index({ tipster: 1, createdAt: -1 });
withdrawalRequestSchema.index({ status: 1 });
withdrawalRequestSchema.index({ reference: 1 });
withdrawalRequestSchema.index({ flwTransferId: 1 });

module.exports = mongoose.model('WithdrawalRequest', withdrawalRequestSchema);
