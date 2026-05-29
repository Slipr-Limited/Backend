/**
 * models/PlatformSettings.js — Singleton config document for platform-wide settings.
 * Only super admin can update. Fetched at runtime rather than from env vars
 * so changes take effect immediately without a redeploy.
 */

'use strict';

const mongoose = require('mongoose');

const platformSettingsSchema = new mongoose.Schema({
  // Ensures only one settings document ever exists
  singleton: { type: String, default: 'config', unique: true, immutable: true },

  platformFeeKobo:          { type: Number, default: 10000  }, // ₦100
  minWithdrawalKobo:        { type: Number, default: 100000 }, // ₦1,000
  maxWithdrawalPerDayKobo:  { type: Number, default: 50000000 }, // ₦500,000
  escrowResolutionWindowHours: { type: Number, default: 48 },
  outcomeWindowMinutes:     { type: Number, default: 90 }, // Minutes after kickoff
  maintenanceMode:          { type: Boolean, default: false },
  maintenanceMessage:       { type: String, default: 'Slipr is currently under maintenance. We\'ll be back shortly.' },
}, {
  timestamps: true,
});

// Convenience static to get (or create) the single settings document
platformSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ singleton: 'config' });
  if (!settings) settings = await this.create({});
  return settings;
};

module.exports = mongoose.model('PlatformSettings', platformSettingsSchema);
