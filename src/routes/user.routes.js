'use strict';

const express = require('express');
const router  = express.Router();
const { protect, optionalAuth } = require('../middleware/auth.middleware');
const { uploadSingle } = require('../middleware/upload.middleware');
const {
  getMe,
  updateMe,
  uploadPhoto,
  getPublicProfile,
  followUser,
  unfollowUser,
  submitKYC,
  getTipsters,
  getFollowing,
  registerPushToken,
  removePushToken,
  requestVerification,
  deleteAccount,
} = require('../controllers/user.controller');

router.get('/me',                         protect, getMe);
router.patch('/me',                       protect, updateMe);
router.delete('/me',                      protect, deleteAccount);
router.post('/me/photo',                  protect, uploadSingle('photo'), uploadPhoto);
router.get('/me/following',               protect, getFollowing);
router.post('/me/request-verification',   protect, requestVerification);
router.post('/kyc',                       protect, submitKYC);
router.get('/tipsters',        optionalAuth, getTipsters);
router.post('/push-token',     protect, registerPushToken);
router.delete('/push-token',   protect, removePushToken);

router.get('/:username',       optionalAuth, getPublicProfile);
router.post('/:id/follow',     protect, followUser);
router.delete('/:id/follow',   protect, unfollowUser);

module.exports = router;
