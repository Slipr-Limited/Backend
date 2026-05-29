'use strict';

/**
 * jobs/keepAlive.job.js — Prevents Render free-tier spin-down.
 *
 * Render's free plan idles a service after 15 minutes of inactivity.
 * This job pings the public /health endpoint every 14 minutes so the
 * instance stays warm. Only runs when RENDER_EXTERNAL_URL is set
 * (i.e. when actually deployed on Render — not in local dev).
 */

const cron   = require('node-cron');
const https  = require('https');
const http   = require('http');
const logger = require('../utils/logger');

const startKeepAlive = () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL;
  if (!baseUrl) return; // not on Render — skip

  const url     = `${baseUrl}/health`;
  const client  = url.startsWith('https') ? https : http;

  cron.schedule('*/14 * * * *', () => {
    const req = client.get(url, (res) => {
      logger.debug(`keepAlive: GET ${url} → ${res.statusCode}`);
    });
    req.on('error', (err) => {
      logger.warn(`keepAlive: ping failed — ${err.message}`);
    });
    req.end();
  });

  logger.info(`keepAlive: pinging ${url} every 14 minutes`);
};

module.exports = { startKeepAlive };
