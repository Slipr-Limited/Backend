'use strict';

const mongoose = require('mongoose');

const followSchema = new mongoose.Schema({
  follower:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  following: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}, {
  timestamps: { createdAt: true, updatedAt: false },
});

// Unique pair — prevents duplicate follows and enables fast exists check
followSchema.index({ follower: 1, following: 1 }, { unique: true });
// Fast "get all followers of tipster X" — used by notifyFollowers + follower lists
followSchema.index({ following: 1 });
// Fast "get all tipsters user X follows" — used by following feed + getFollowing
followSchema.index({ follower: 1 });

module.exports = mongoose.model('Follow', followSchema);
