/**
 * config/db.js — MongoDB connection via Mongoose.
 * Exported as an async function so server.js can await it during boot.
 */

'use strict';

const mongoose = require('mongoose');
const logger = require('../utils/logger');

/**
 * Connects to MongoDB using the MONGODB_URI from env.
 * Exits the process on failure so we don't boot a broken server.
 */
const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      maxPoolSize: 200,
      minPoolSize: 10,
      maxIdleTimeMS: 30000,
      // Route reads to secondaries when available (Atlas replica sets) to reduce primary load
      readPreference: 'secondaryPreferred',
    });

    logger.info(`MongoDB connected: ${conn.connection.host}`);

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected — attempting to reconnect...');
    });

    mongoose.connection.on('error', (err) => {
      logger.error('MongoDB connection error:', err);
    });
  } catch (err) {
    logger.error('MongoDB connection failed:', err.message);
    throw err; // Let server.js handle the exit
  }
};

module.exports = connectDB;
