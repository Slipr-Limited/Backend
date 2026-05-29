/**
 * models/Wallet.js — One wallet per user.
 * balance:        Spendable funds (withdrawable for tipsters, spendable for buyers).
 * escrowBalance:  Buyer funds locked in active escrow pending slip outcome.
 * totalEarned:    Lifetime tipster earnings from won slips.
 * totalSpent:     Lifetime buyer spend on slip unlocks.
 * totalRefunded:  Lifetime buyer refunds received on lost slips.
 * totalWithdrawn: Lifetime tipster cash-outs to bank.
 * All amounts stored in KOBO; converted to naira in toJSON.
 */

'use strict';

const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    unique: true,
    required: true,
    index: true,
  },

  // All amounts in KOBO
  balance:         { type: Number, default: 0, min: 0, index: true },
  escrowBalance:   { type: Number, default: 0, min: 0, index: true },
  totalEarned:     { type: Number, default: 0 },
  totalSpent:      { type: Number, default: 0 },
  totalRefunded:   { type: Number, default: 0 },
  totalWithdrawn:  { type: Number, default: 0 },

  updatedAt: { type: Date, default: Date.now },
}, {
  toJSON: {
    transform(_doc, ret) {
      // Convert kobo → naira for every API response
      ret.balance        = ret.balance        / 100;
      ret.escrowBalance  = ret.escrowBalance  / 100;
      ret.totalEarned    = ret.totalEarned    / 100;
      ret.totalSpent     = ret.totalSpent     / 100;
      ret.totalRefunded  = ret.totalRefunded  / 100;
      ret.totalWithdrawn = ret.totalWithdrawn / 100;
      return ret;
    },
  },
});

module.exports = mongoose.model('Wallet', walletSchema);
