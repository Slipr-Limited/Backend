'use strict';

const paginate = require('./paginate');

/**
 * Runs countDocuments + find in parallel and returns normalized pagination.
 *
 * @param {import('mongoose').Model} Model
 * @param {object}  filter   - Mongoose query filter
 * @param {object}  opts     - { page, limit, sort, skip, select, populate, lean }
 * @returns {Promise<{ docs: any[], pagination: object }>}
 */
const queryPage = async (Model, filter, {
  page  = 1,
  limit = 20,
  sort  = { createdAt: -1 },
  select,
  populate,
  lean  = true,
} = {}) => {
  const skip = (page - 1) * limit;

  let query = Model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select)   query = query.select(select);
  if (populate) query = Array.isArray(populate) ? populate.reduce((q, p) => q.populate(p), query) : query.populate(populate);
  if (lean)     query = query.lean();

  const [total, docs] = await Promise.all([
    Model.countDocuments(filter),
    query,
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);
  return { docs, pagination };
};

module.exports = queryPage;
