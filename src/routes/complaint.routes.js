'use strict';

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { submitComplaint } = require('../controllers/complaint.controller');

router.post('/', protect, submitComplaint);

module.exports = router;
