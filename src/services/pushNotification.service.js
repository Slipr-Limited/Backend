/**
 * services/pushNotification.service.js — Expo push notifications.
 * Sends push alerts for tip outcomes, new followers, and purchases.
 * Uses Expo's push API (no FCM credentials needed in dev).
 */

'use strict';

const axios  = require('axios');
const User   = require('../models/User');
const Follow = require('../models/Follow');
const logger = require('../utils/logger');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Sends a push notification to a single user by their userId.
 * Silently no-ops if the user has no push token.
 *
 * @param {string} userId
 * @param {string} title
 * @param {string} body
 * @param {Object} [data={}]  - Payload sent to the app (e.g. { screen: 'PurchaseDetail', id })
 */
const sendPush = async (userId, title, body, data = {}) => {
  try {
    const user = await User.findById(userId).select('+pushToken').lean();
    if (!user?.pushToken) return;

    const message = {
      to:    user.pushToken,
      sound: 'default',
      title,
      body,
      data,
      priority: 'high',
    };

    const res = await axios.post(EXPO_PUSH_URL, message, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 8000,
    });

    const receipt = res.data?.data;
    if (receipt?.status === 'error') {
      logger.warn(`Push failed for user ${userId}: ${receipt.message}`);
      // If the device token is invalid, clear it
      if (receipt.details?.error === 'DeviceNotRegistered') {
        await User.findByIdAndUpdate(userId, { pushToken: null });
      }
    }
  } catch (err) {
    logger.warn(`pushNotification.sendPush error for user ${userId}:`, err.message);
  }
};

/**
 * Sends the same push to multiple users (batch, max 100 per call).
 */
const sendBatch = async (messages) => {
  if (!messages?.length) return;
  try {
    const chunks = [];
    for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));
    await Promise.all(chunks.map((chunk) =>
      axios.post(EXPO_PUSH_URL, chunk, {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 10000,
      })
    ));
  } catch (err) {
    logger.warn('pushNotification.sendBatch error:', err.message);
  }
};

/**
 * Notifies followers of a new listing via push.
 */
const pushNotifyFollowers = async (tipsterId, tipsterUsername, listingId) => {
  try {
    // Follow collection replaces the old followers array on User
    const follows = await Follow.find({ following: tipsterId }).select('follower').lean();
    if (!follows.length) return;

    const followerIds = follows.map((f) => f.follower);
    const followers   = await User.find({ _id: { $in: followerIds } }).select('+pushToken').lean();
    const messages    = followers
      .filter((f) => f.pushToken)
      .map((f) => ({
        to:    f.pushToken,
        sound: 'default',
        title: '📢 New slip posted',
        body:  `@${tipsterUsername} just dropped a new slip. Don't miss it!`,
        data:  { screen: 'SinglePost', listingId },
        priority: 'high',
      }));

    await sendBatch(messages);
  } catch (err) {
    logger.warn('pushNotifyFollowers error:', err.message);
  }
};

module.exports = { sendPush, sendBatch, pushNotifyFollowers };
