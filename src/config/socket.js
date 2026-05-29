/**
 * config/socket.js — Socket.io server setup.
 * Authenticates every connection via JWT query param.
 * Joins each connected user to their own private room (userId).
 * Exports initSocket (called in server.js) and getIO (for services that emit events).
 */

'use strict';

const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Redis } = require('ioredis');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

let io = null;

/**
 * Attaches Socket.io to the provided HTTP server.
 * Wires up the Redis adapter so events emitted on any PM2 cluster process
 * reach clients connected to every other process.
 * @param {http.Server} httpServer - The Node.js HTTP server instance
 */
const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:3000',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
  });

  // Redis pub/sub adapter — required for correct behaviour in PM2 cluster mode
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const tlsOpts  = redisUrl.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {};
  const pubClient = new Redis(redisUrl, { ...tlsOpts, maxRetriesPerRequest: 0, lazyConnect: true });
  const subClient = pubClient.duplicate();

  pubClient.on('error', (err) => logger.warn('Socket pubClient Redis error:', err.message));
  subClient.on('error', (err) => logger.warn('Socket subClient Redis error:', err.message));

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.io Redis adapter attached');
    })
    .catch((err) => {
      logger.warn('Socket.io Redis adapter unavailable — single-process mode only:', err.message);
    });

  // Middleware: authenticate every socket connection with JWT
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token) {
      return next(new Error('Authentication token missing'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      next();
    } catch (err) {
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.userId;
    logger.info(`Socket connected: userId=${userId}`);

    // Each user joins their own private room for targeted events
    socket.join(userId);

    socket.on('disconnect', () => {
      logger.info(`Socket disconnected: userId=${userId}`);
    });
  });

  logger.info('Socket.io initialised');
  return io;
};

/**
 * Returns the Socket.io server instance.
 * Must be called after initSocket() — used by notification.service.js.
 */
const getIO = () => {
  if (!io) throw new Error('Socket.io not initialised. Call initSocket() first.');
  return io;
};

module.exports = { initSocket, getIO };
