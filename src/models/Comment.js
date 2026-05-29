/**
 * models/Comment.js — Comments on free listings.
 * Paid listings cannot receive comments — enforced at route level (403).
 * Soft-deleted via isDeleted flag; deleted text replaced client-side with placeholder.
 */

'use strict';

const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema({
  listing: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    required: true,
    index: true,
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  text: {
    type: String,
    required: true,
    maxlength: 300,
    trim: true,
  },
  likes:     [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  likeCount: { type: Number, default: 0 },

  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date, default: null },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
});

// Paginated comment fetch index
commentSchema.index({ listing: 1, createdAt: -1 });
commentSchema.index({ listing: 1, isDeleted: 1 });

module.exports = mongoose.model('Comment', commentSchema);
