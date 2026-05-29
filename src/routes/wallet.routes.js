'use strict';

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { getWallet, getTransactions, initiateDeposit, verifyDeposit } = require('../controllers/wallet.controller');

router.get('/',                  protect, getWallet);
router.get('/transactions',      protect, getTransactions);
router.post('/deposit',          protect, initiateDeposit);
router.post('/deposit/verify',   protect, verifyDeposit);

module.exports = router;
