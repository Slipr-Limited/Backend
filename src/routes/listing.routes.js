'use strict';

const express = require('express');
const router  = express.Router();
const { protect, optionalAuth } = require('../middleware/auth.middleware');
const { requireTipster } = require('../middleware/tipster.middleware');
const { purchaseLimiter } = require('../middleware/rateLimit.middleware');
const {
  createListing,
  getForYou,
  getFollowing,
  getListing,
  getMyListings,
  getTipsterPublicListings,
  updateListing,
  deleteListing,
  submitVerdict,
  boostListing,
} = require('../controllers/listing.controller');
router.get('/feed/foryou',          optionalAuth, getForYou);
router.get('/feed/following',       protect, getFollowing);
router.get('/mine',                 protect, requireTipster, getMyListings);
router.get('/tipster/:tipsterId',   optionalAuth, getTipsterPublicListings);

router.post('/',             protect, requireTipster, purchaseLimiter, createListing);
router.get('/:id',           optionalAuth, getListing);
router.post('/:id/boost',    protect, requireTipster, boostListing);
router.patch('/:id/verdict', protect, requireTipster, submitVerdict);
router.patch('/:id',         protect, requireTipster, updateListing);
router.delete('/:id',        protect, requireTipster, deleteListing);

module.exports = router;
