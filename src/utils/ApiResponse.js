/**
 * utils/ApiResponse.js — Standardised JSON response helpers.
 * All controllers use these to ensure a consistent response envelope.
 *
 * Success shape: { success: true, message, data }
 * Error shape:   { success: false, message, errors }
 */

'use strict';

class ApiResponse {
  /**
   * Send a successful JSON response.
   * @param {Response} res - Express response object
   * @param {*} data - Payload to include in response
   * @param {string} message - Human-readable success message
   * @param {number} statusCode - HTTP status code (default 200)
   */
  static success(res, data, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
    });
  }

  /**
   * Send an error JSON response.
   * @param {Response} res - Express response object
   * @param {string} message - Human-readable error message
   * @param {number} statusCode - HTTP status code (default 400)
   * @param {Array|null} errors - Array of validation errors or null
   */
  static error(res, message = 'Error', statusCode = 400, errors = null) {
    const body = { success: false, message };
    if (errors) body.errors = errors;
    return res.status(statusCode).json(body);
  }
}

module.exports = ApiResponse;
