/**
 * utils/encrypt.js — AES-256-CBC encryption/decryption for sensitive fields.
 * Used to encrypt BVN and NIN before saving to MongoDB.
 * ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
 */

'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16; // AES block size in bytes

const getKey = () => {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY env var must be at least 32 characters');
  }
  // Use first 32 bytes of the key
  return Buffer.from(key.slice(0, 64), 'hex').slice(0, 32);
};

/**
 * Encrypts a plaintext string using AES-256-CBC.
 * @param {string} text - Plaintext to encrypt
 * @returns {string} "iv:ciphertext" hex string
 */
const encrypt = (text) => {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

/**
 * Decrypts an AES-256-CBC encrypted string.
 * @param {string} encryptedText - "iv:ciphertext" hex string
 * @returns {string} Decrypted plaintext
 */
const decrypt = (encryptedText) => {
  if (!encryptedText) return null;
  const [ivHex, encryptedHex] = encryptedText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encryptedBuffer = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encryptedBuffer), decipher.final()]);
  return decrypted.toString('utf8');
};

module.exports = { encrypt, decrypt };
