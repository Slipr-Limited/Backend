'use strict';

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const {
  subscribe,
  cancelSubscription,
  getSubscriptionStatus,
} = require('../controllers/subscription.controller');

router.get('/',    protect, getSubscriptionStatus);
router.post('/',   protect, subscribe);
router.delete('/', protect, cancelSubscription);

module.exports = router;
