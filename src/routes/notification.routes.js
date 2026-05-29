'use strict';

const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/auth.middleware');
const {
  getNotifications,
  markRead,
  markAllRead,
  deleteNotification,
} = require('../controllers/notification.controller');

router.get('/',                   protect, getNotifications);
router.patch('/read-all',         protect, markAllRead);
router.patch('/:id/read',         protect, markRead);
router.delete('/:id',             protect, deleteNotification);

module.exports = router;
