'use strict';

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const { authLimiter } = require('../middleware/rateLimit.middleware');
const {
  register,
  login,
  refresh,
  logout,
  verifyEmail,
  forgotPassword,
  resetPassword,
  googleAuth,
  appleAuth,
} = require('../controllers/auth.controller');

router.post('/register',        authLimiter, register);
router.post('/login',           authLimiter, login);
router.post('/google',          authLimiter, googleAuth);
router.post('/apple',           authLimiter, appleAuth);
router.post('/refresh',         authLimiter, refresh);
router.post('/logout',          protect, logout);
router.get('/verify-email',     verifyEmail);
router.post('/forgot-password', authLimiter, forgotPassword);
router.post('/reset-password',  authLimiter, resetPassword);

module.exports = router;
