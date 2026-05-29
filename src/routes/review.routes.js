'use strict';

const express = require('express');
const router  = express.Router();
const { protect, optionalAuth } = require('../middleware/auth.middleware');
const { createReview, getTipsterReviews, deleteReview } = require('../controllers/review.controller');

router.post('/',                        protect,      createReview);
router.get('/tipster/:tipsterId',        optionalAuth, getTipsterReviews);
router.delete('/:id',                   protect,      deleteReview);

module.exports = router;
