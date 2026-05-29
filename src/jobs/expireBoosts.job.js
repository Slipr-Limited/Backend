'use strict';

/**
 * jobs/expireBoosts.job.js — Expires listing boosts whose endDate has passed.
 * Runs every 15 minutes.
 */

const cron    = require('node-cron');
const Listing = require('../models/Listing');
const logger  = require('../utils/logger');

const expireBoosts = async () => {
  const now = new Date();

  const result = await Listing.updateMany(
    { 'boost.isActive': true, 'boost.endDate': { $lte: now } },
    { $set: { 'boost.isActive': false } },
  );

  if (result.modifiedCount > 0) {
    logger.info(`expireBoosts: expired ${result.modifiedCount} boost(s)`);
  }
};

cron.schedule('*/15 * * * *', async () => {
  try {
    await expireBoosts();
  } catch (err) {
    logger.error('expireBoosts job error:', err);
  }
});

logger.info('expireBoosts cron registered (every 15 minutes)');
