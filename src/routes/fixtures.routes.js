/**
 * routes/fixtures.routes.js — API-Football fixture endpoints.
 * Mounted at /api/fixtures in app.js.
 *
 * GET /api/fixtures/search   — search fixtures for a date (tipster auth required)
 * GET /api/fixtures/:id      — single fixture result (tipster auth required)
 */

'use strict';

const { Router } = require('express');
const { protect } = require('../middleware/auth.middleware');
const { requireTipster } = require('../middleware/tipster.middleware');
const { searchFixturesHandler, getFixtureResultHandler, getFixtureOddsHandler } = require('../controllers/fixtures.controller');

const router = Router();

// Tipster-only — non-tipsters have no reason to browse fixtures
router.get('/search',       protect, requireTipster, searchFixturesHandler);
router.get('/odds',         protect, requireTipster, getFixtureOddsHandler);
router.get('/:fixtureId',   protect, requireTipster, getFixtureResultHandler);

module.exports = router;
