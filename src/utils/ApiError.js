/**
 * utils/ApiError.js — Custom operational error class.
 * Thrown from services and controllers to trigger the global error handler.
 * The handler uses err.statusCode to set the HTTP status.
 */

'use strict';

class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status code to respond with
   * @param {string} message - Human-readable error description
   * @param {Array} errors - Optional array of validation error details
   */
  constructor(statusCode, message, errors = []) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true; // Distinguishes expected errors from bugs
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = ApiError;
