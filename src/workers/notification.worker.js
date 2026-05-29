'use strict';

const { Worker } = require('bullmq');
const { connection } = require('../queues/queues');
const Follow       = require('../models/Follow');
const User         = require('../models/User');
const Notification = require('../models/Notification');
const { sendBatch } = require('../services/pushNotification.service');
const logger = require('../utils/logger');

const BATCH_SIZE = 500; // followers processed per DB round-trip

/**
 * Processes a notify-followers job.
 * Fans out in-app notifications, socket events, and push notifications to all
 * followers of a tipster without blocking the originating HTTP request.
 */
const processNotifyFollowers = async (job) => {
  const { tipsterId, listingId, tipsterUsername } = job.data;

  // Stream follower IDs in batches using cursor — avoids loading 500k docs into memory
  let skip = 0;
  let totalNotified = 0;

  // Lazy-load socket to avoid circular dependency issues at module load time
  const getIO = () => {
    try { return require('../config/socket').getIO(); } catch { return null; }
  };

  while (true) {
    const batch = await Follow.find({ following: tipsterId })
      .select('follower')
      .skip(skip)
      .limit(BATCH_SIZE)
      .lean();

    if (!batch.length) break;

    const followerIds = batch.map((f) => f.follower);

    // 1. Bulk-insert in-app Notification docs (one DB write per batch)
    const notifDocs = followerIds.map((id) => ({
      user:           id,
      type:           'new_listing',
      title:          '📢 New slip posted',
      body:           `@${tipsterUsername} just posted a new slip. Be quick — it sells out!`,
      relatedListing: listingId,
    }));

    try {
      await Notification.insertMany(notifDocs, { ordered: false });
    } catch (err) {
      // ordered: false continues on duplicates — log but don't fail the job
      logger.warn(`Notification insertMany partial error (batch ${skip}):`, err.message);
    }

    // 2. Emit socket events — Redis adapter broadcasts to all PM2 processes
    const io = getIO();
    if (io) {
      const payload = {
        title:          '📢 New slip posted',
        body:           `@${tipsterUsername} just posted a new slip. Be quick — it sells out!`,
        relatedListing: listingId,
      };
      followerIds.forEach((id) => io.to(id.toString()).emit('new_listing', payload));
    }

    // 3. Push notifications — only to followers with a push token
    try {
      const usersWithToken = await User.find({
        _id:       { $in: followerIds },
        pushToken: { $ne: null },
      }).select('+pushToken').lean();

      const messages = usersWithToken.map((u) => ({
        to:       u.pushToken,
        sound:    'default',
        title:    '📢 New slip posted',
        body:     `@${tipsterUsername} just dropped a new slip. Don't miss it!`,
        data:     { screen: 'SinglePost', listingId },
        priority: 'high',
      }));

      await sendBatch(messages);
    } catch (err) {
      logger.warn(`Push batch error (batch ${skip}):`, err.message);
    }

    totalNotified += followerIds.length;
    skip += BATCH_SIZE;
    await job.updateProgress(Math.round((skip / (skip + BATCH_SIZE)) * 100));
  }

  logger.info(`notify-followers job done: tipster=${tipsterId}, notified=${totalNotified}`);
};

let worker = null;

const startNotificationWorker = () => {
  if (worker) return;

  worker = new Worker('notifications', processNotifyFollowers, {
    connection,
    concurrency: 3,
  });

  worker.on('completed', (job) =>
    logger.debug(`Notification job ${job.id} completed`)
  );
  worker.on('failed', (job, err) =>
    logger.error(`Notification job ${job?.id} failed:`, err.message)
  );
  worker.on('error', (err) =>
    logger.error('Notification worker error:', err.message)
  );

  logger.info('Notification worker started');
  return worker;
};

const stopNotificationWorker = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};

module.exports = { startNotificationWorker, stopNotificationWorker };
