/**
 * controllers/fixtures.controller.js — Multi-sport fixture search endpoints.
 *
 * Endpoints:
 *   GET /api/fixtures/search?date=YYYY-MM-DD&league=optional&sport=football — fixture list
 *   GET /api/fixtures/:fixtureId?sport=football                             — single fixture result
 */

'use strict';

const { searchFixtures, searchFixturesRange, getFixtureResult } = require('../services/apiFootball.service');
const { getFixtureOdds } = require('../services/odds.service');
const ApiResponse  = require('../utils/ApiResponse');
const ApiError     = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const VALID_SPORTS = new Set(['football', 'basketball', 'baseball']);

/**
 * GET /api/fixtures/search
 * Returns fixtures for a date so tipsters can pick matches for tracked listings.
 * Query: date (required, YYYY-MM-DD), league (optional), sport (optional, default football)
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const searchFixturesHandler = asyncHandler(async (req, res) => {
  // Support dateFrom/dateTo for range queries, and legacy `date` for single-day
  const { dateFrom, dateTo, date, league, sport = 'football' } = req.query;

  const from = dateFrom || date;
  const to   = dateTo   || from;

  if (!from || !DATE_RE.test(from)) throw new ApiError(400, 'dateFrom is required in YYYY-MM-DD format');
  if (!DATE_RE.test(to))            throw new ApiError(400, 'dateTo must be in YYYY-MM-DD format');
  if (to < from)                    throw new ApiError(400, 'dateTo must be on or after dateFrom');

  const validSport = VALID_SPORTS.has(sport) ? sport : 'football';
  const fixtures   = await searchFixturesRange(from, to, league || '', validSport);

  return ApiResponse.success(res, { fixtures, count: fixtures.length }, 'Fixtures retrieved');
});

/**
 * GET /api/fixtures/:fixtureId
 * Returns current result of a specific fixture.
 * Query: sport (optional, default football)
 */
const getFixtureResultHandler = asyncHandler(async (req, res) => {
  const id = parseInt(req.params.fixtureId, 10);
  if (isNaN(id)) throw new ApiError(400, 'fixtureId must be a number');

  const { sport = 'football' } = req.query;
  const validSport = VALID_SPORTS.has(sport) ? sport : 'football';

  const result = await getFixtureResult(id, validSport);
  if (!result) throw new ApiError(404, 'Fixture not found');

  return ApiResponse.success(res, result, 'Fixture result retrieved');
});

/**
 * GET /api/fixtures/odds?fixtureId=as_592872&kickoff=2025-05-10T15:00:00Z&homeTeam=Arsenal&awayTeam=Chelsea
 * Returns live odds for a specific fixture from api-sports.
 * Used by CreateListingScreen to auto-populate odds when a selection is made.
 */
const getFixtureOddsHandler = asyncHandler(async (req, res) => {
  const { fixtureId, kickoff, homeTeam, awayTeam } = req.query;
  if (!fixtureId) throw new ApiError(400, 'fixtureId is required');

  const odds = await getFixtureOdds(fixtureId, kickoff || '', homeTeam || '', awayTeam || '');
  return ApiResponse.success(res, odds, 'Odds retrieved');
});

module.exports = { searchFixturesHandler, getFixtureResultHandler, getFixtureOddsHandler };
