'use strict';

const express = require('express');
const router  = express.Router();
const { handleFlutterwaveWebhook } = require('../controllers/webhook.controller');

// Flutterwave verifies using a plain header (verif-hash), not HMAC of raw body.
// express.json() is applied globally so this route receives a parsed body already.
router.post('/flutterwave', handleFlutterwaveWebhook);

module.exports = router;
