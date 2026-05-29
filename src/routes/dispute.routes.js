'use strict';

const express = require('express');
const router  = express.Router();
const { protect }  = require('../middleware/auth.middleware');
const {
  raiseDispute,
  getMyDisputes,
  getDispute,
} = require('../controllers/dispute.controller');

router.post('/',   protect, raiseDispute);
router.get('/mine', protect, getMyDisputes);
router.get('/:id',  protect, getDispute);

module.exports = router;
