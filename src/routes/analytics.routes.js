/**
 * routes/analytics.routes.js — Analytics and leaderboard endpoints.
 * All routes are public (no auth required) — analytics data is visible to all users.
 *
 * GET /api/analytics/tipster/:id           — full analytics document
 * GET /api/analytics/tipster/:id/pnl-chart — weekly chart data
 * GET /api/analytics/leaderboard/weekly    — top 10 by weekly score
 * GET /api/analytics/leaderboard/monthly   — top 10 by monthly score
 * GET /api/analytics/leaderboard/alltime   — top 10 all-time
 */

'use strict';

const { Router } = require('express');
const {
  getTipsterAnalytics,
  getPnlChart,
  getWeeklyLeaderboard,
  getMonthlyLeaderboard,
  getAllTimeLeaderboard,
} = require('../controllers/analytics.controller');

const router = Router();

// Leaderboard routes — ordering matters: specific before parameterised
router.get('/leaderboard/weekly',  getWeeklyLeaderboard);
router.get('/leaderboard/monthly', getMonthlyLeaderboard);
router.get('/leaderboard/alltime', getAllTimeLeaderboard);

// Per-tipster routes
router.get('/tipster/:id/pnl-chart', getPnlChart);
router.get('/tipster/:id',           getTipsterAnalytics);

module.exports = router;
