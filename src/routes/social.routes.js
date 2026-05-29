/**
 * routes/social.routes.js — Listing likes and comments.
 * Mounted at /api/listings in app.js (extends listing routes).
 *
 * POST   /api/listings/:id/like                     — toggle like (free + paid)
 * GET    /api/listings/:id/comments                 — get paginated comments (free only)
 * POST   /api/listings/:id/comments                 — create comment (free only)
 * DELETE /api/listings/:id/comments/:commentId      — soft delete comment
 * POST   /api/listings/:id/comments/:commentId/like — toggle comment like
 */

'use strict';

const { Router } = require('express');
const { protect, optionalAuth } = require('../middleware/auth.middleware');
const {
  toggleListingLike,
  getComments,
  createComment,
  deleteComment,
  toggleCommentLike,
} = require('../controllers/social.controller');

const router = Router({ mergeParams: true });

router.post('/:id/like',                            protect,      toggleListingLike);
router.get('/:id/comments',                         optionalAuth, getComments);
router.post('/:id/comments',                        protect,      createComment);
router.delete('/:id/comments/:commentId',           protect,      deleteComment);
router.post('/:id/comments/:commentId/like',        protect,      toggleCommentLike);

module.exports = router;
