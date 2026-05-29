/**
 * services/notification.service.js — In-app + email notifications.
 * Persists Notification documents to MongoDB and emits real-time Socket.io events.
 * Heavy fan-out (notifyFollowers) is offloaded to the BullMQ notification worker.
 */

'use strict';

const nodemailer = require('nodemailer');
const Notification = require('../models/Notification');
const logger = require('../utils/logger');

// Lazy-load socket to avoid circular dependency issues
const getIO = () => require('../config/socket').getIO();

// Lazy-load queue to avoid loading BullMQ before Redis is ready
const getNotificationQueue = () => require('../queues/queues').notificationQueue;

// ── Nodemailer transport via SendGrid SMTP ─────────────────────────────────
const transporter = nodemailer.createTransport({
  host: 'smtp.sendgrid.net',
  port: 587,
  auth: {
    user: 'apikey',
    pass: process.env.SENDGRID_API_KEY,
  },
});

/**
 * Creates an in-app notification and emits it via Socket.io.
 *
 * @param {string} userId - Recipient user _id
 * @param {string} type - Notification type (must match Notification schema enum)
 * @param {string} title - Short notification title
 * @param {string} body - Full notification body text
 * @param {Object} relatedData - Optional { relatedListing, relatedPurchase }
 * @returns {Promise<Notification>}
 */
const sendInApp = async (userId, type, title, body, relatedData = {}) => {
  try {
    const notification = await Notification.create({
      user: userId,
      type,
      title,
      body,
      relatedListing:  relatedData.relatedListing  || null,
      relatedPurchase: relatedData.relatedPurchase || null,
    });

    try {
      getIO().to(userId.toString()).emit(type, {
        notificationId:  notification._id,
        title,
        body,
        relatedListing:  relatedData.relatedListing  || null,
        relatedPurchase: relatedData.relatedPurchase || null,
        createdAt: notification.createdAt,
      });
    } catch (socketErr) {
      logger.warn('Socket.io emit failed:', socketErr.message);
    }

    return notification;
  } catch (err) {
    logger.error('sendInApp failed:', err);
  }
};

/**
 * Sends an email via SendGrid SMTP.
 *
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject line
 * @param {string} html - Email HTML body
 */
const sendEmail = async (to, subject, html) => {
  try {
    await transporter.sendMail({
      from: `"Slipr" <${process.env.EMAIL_FROM || 'noreply@slipr.ng'}>`,
      to,
      subject,
      html,
    });
    logger.info(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    logger.error(`Email failed to ${to}:`, err.message);
  }
};

/**
 * Enqueues a fan-out notification job for all followers of a tipster.
 * The actual fan-out runs in the notification worker — does NOT block the HTTP thread.
 *
 * @param {string} tipsterId - The tipster who posted the listing
 * @param {string} listingId - The new listing _id
 * @param {string} tipsterUsername - For the notification body
 */
const notifyFollowers = async (tipsterId, listingId, tipsterUsername) => {
  try {
    await getNotificationQueue().add('notify-followers', {
      tipsterId,
      listingId,
      tipsterUsername,
    });
    logger.debug(`notify-followers job queued: tipster=${tipsterId}`);
  } catch (err) {
    logger.error('notifyFollowers queue add failed:', err);
  }
};

/**
 * Notifies the admin room about a new dispute.
 * @param {string} disputeId
 * @param {string} purchaseId
 */
const notifyAdminDispute = async (disputeId, purchaseId) => {
  try {
    getIO().to('admin').emit('dispute_opened', { disputeId, purchaseId });
    logger.info(`Admin notified of dispute: ${disputeId}`);
  } catch (err) {
    logger.warn('Admin socket notification failed:', err.message);
  }
};

module.exports = { sendInApp, sendEmail, notifyFollowers, notifyAdminDispute };
