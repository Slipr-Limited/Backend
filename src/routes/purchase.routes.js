'use strict';

const express = require('express');
const router  = express.Router();
const { protect }  = require('../middleware/auth.middleware');
const { purchaseLimiter } = require('../middleware/rateLimit.middleware');
const {
  initiatePurchase,
  getMyPurchases,
  getPurchase,
  verifyPurchase,
} = require('../controllers/purchase.controller');

// KYC is NOT required to purchase — only required for tipster withdrawals
router.post('/',          protect, purchaseLimiter, initiatePurchase);
router.get('/mine',       protect, getMyPurchases);
router.get('/:id',        protect, getPurchase);
router.post('/:id/verify', protect, verifyPurchase);

module.exports = router;
