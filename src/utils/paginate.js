/**
 * utils/paginate.js — Pagination helper.
 * Parses page/limit from query params and returns Mongoose-ready skip/limit values.
 */

'use strict';

/**
 * Calculates pagination parameters from a total document count.
 * @param {number|string} page - Current page number (1-indexed)
 * @param {number|string} limit - Documents per page (capped at 100)
 * @param {number} totalDocs - Total number of matching documents
 * @returns {{ skip: number, limit: number, page: number, totalPages: number, totalDocs: number }}
 */
const paginate = (page = 1, limit = 20, totalDocs = 0) => {
  const parsedPage  = Math.max(1, parseInt(page, 10) || 1);
  const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip        = (parsedPage - 1) * parsedLimit;
  const totalPages  = Math.ceil(totalDocs / parsedLimit) || 1;

  return { skip, limit: parsedLimit, page: parsedPage, totalPages, totalDocs };
};

module.exports = paginate;
