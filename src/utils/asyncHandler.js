/**
 * utils/asyncHandler.js — Wraps async Express route handlers.
 * Catches any rejected promise and forwards it to next() (global error handler).
 * Usage: router.get('/path', asyncHandler(async (req, res) => { ... }))
 */

'use strict';

/**
 * @param {Function} fn - Async Express handler (req, res, next)
 * @returns {Function} Express middleware that catches async errors
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
