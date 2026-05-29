'use strict';

const express  = require('express');
const router   = express.Router();
const { optionalAuth } = require('../middleware/auth.middleware');
const { searchUsers, searchListings } = require('../controllers/search.controller');

router.get('/users',    optionalAuth, searchUsers);
router.get('/listings', optionalAuth, searchListings);

module.exports = router;
