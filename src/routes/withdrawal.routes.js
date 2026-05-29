'use strict';

const express = require('express');
const router  = express.Router();
const { protect }        = require('../middleware/auth.middleware');
const { requireTipster } = require('../middleware/tipster.middleware');
const { requireKYC }     = require('../middleware/kyc.middleware');
const { purchaseLimiter } = require('../middleware/rateLimit.middleware');
const {
  getBanks,
  verifyAccount,
  requestWithdrawal,
  getWithdrawals,
} = require('../controllers/withdrawal.controller');

router.get('/banks',           protect, getBanks);
router.post('/verify-account', protect, verifyAccount);

router.post('/', protect, requireTipster, requireKYC, purchaseLimiter, requestWithdrawal);
router.get('/',  protect, requireTipster, getWithdrawals);

module.exports = router;
