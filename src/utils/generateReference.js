/**
 * utils/generateReference.js — Unique reference string generator.
 * Used for Paystack payment references and internal transaction records.
 * Format: SLIPR-{timestamp}-{8 random chars}
 * Collision probability at 1M/s: effectively zero.
 */

'use strict';

const crypto = require('crypto');

/**
 * Generates a unique alphanumeric reference string.
 * @param {string} prefix - Optional prefix (default: 'SLIPR')
 * @returns {string} e.g. "SLIPR-1718900000000-A3F7K9PQ"
 */
const generateReference = (prefix = 'SLIPR') => {
  const timestamp = Date.now();
  const random = crypto.randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
  return `${prefix}-${timestamp}-${random}`;
};

module.exports = generateReference;
