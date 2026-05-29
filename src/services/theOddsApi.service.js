'use strict';

/**
 * services/theOddsApi.service.js — Odds from the-odds-api.com
 *
 * Free tier: 500 requests/month.
 * Strategy: fetch ALL upcoming events for a sport (1 request), cache for 30 min,
 * then do team-name + date matching client-side. This keeps request count very low.
 *
 * Markets fetched: h2h (1X2), spreads (Asian handicap), totals (O/U), btts, double_chance
 */

const axios  = require('axios');
const logger = require('../utils/logger');

const BASE_URL = 'https://api.the-odds-api.com/v4/sports';
const REGIONS  = 'eu';  // European bookmakers (Bet365, Unibet, etc.)
const MARKETS  = 'h2h,spreads,totals,btts,double_chance';

// ── Redis helpers ─────────────────────────────────────────────────────────────

const getRedis = () => {
  try { return require('../config/redis').getRedisClient(); } catch { return null; }
};
const cacheGet = async (key) => {
  const r = getRedis();
  if (!r) return null;
  try { const v = await r.get(key); return v ? JSON.parse(v) : null; } catch { return null; }
};
const cacheSet = async (key, data, ttl) => {
  const r = getRedis();
  if (!r) return;
  try { await r.set(key, JSON.stringify(data), 'EX', ttl); } catch {}
};

// ── League name → the-odds-api sport slug ─────────────────────────────────────

const LEAGUE_SPORT_MAP = {
  // Football / Soccer
  'premier league':    'soccer_epl',
  'epl':               'soccer_epl',
  'la liga':           'soccer_spain_la_liga',
  'laliga':            'soccer_spain_la_liga',
  'bundesliga':        'soccer_germany_bundesliga',
  'serie a':           'soccer_italy_serie_a',
  'ligue 1':           'soccer_france_ligue_one',
  'ligue1':            'soccer_france_ligue_one',
  'eredivisie':        'soccer_netherlands_eredivisie',
  'primeira liga':     'soccer_portugal_primeira_liga',
  'liga nos':          'soccer_portugal_primeira_liga',
  'champions league':  'soccer_uefa_champs_league',
  'ucl':               'soccer_uefa_champs_league',
  'europa league':     'soccer_uefa_europa_league',
  'uel':               'soccer_uefa_europa_league',
  'conference league': 'soccer_uefa_europa_conference_league',
  'world cup':         'soccer_world_cup_winner',
  // Nigerian / African
  'npfl':              'soccer_nigeria_professional_football_league',
  'afcon':             'soccer_africa_cup_of_nations',
  // Basketball
  'nba':               'basketball_nba',
  'euroleague':        'basketball_euroleague',
  // Baseball
  'mlb':               'baseball_mlb',
};

const getOddsSportSlug = (leagueName = '') => {
  const lo = leagueName.toLowerCase().trim();
  return LEAGUE_SPORT_MAP[lo] ?? 'soccer_epl'; // default fallback
};

// ── Team name normalisation ───────────────────────────────────────────────────

const normalise = (name = '') =>
  name
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|bsc|rsc|fk|sk|bv|sv|ac|as|rb|1\.)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();

const teamsMatch = (a, b) => {
  const na = normalise(a);
  const nb = normalise(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
};

// ── Fetch all upcoming events for a sport (cached per sport, 30 min TTL) ──────

const fetchSportEvents = async (sportSlug) => {
  const key = `theoddsapi:events:${sportSlug}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) {
    logger.warn('theOddsApi: ODDS_API_KEY not set');
    return [];
  }

  try {
    const { data } = await axios.get(`${BASE_URL}/${sportSlug}/odds/`, {
      params: { apiKey, regions: REGIONS, markets: MARKETS, dateFormat: 'iso', oddsFormat: 'decimal' },
      timeout: 12000,
    });

    const events = Array.isArray(data) ? data : [];
    if (events.length) await cacheSet(key, events, 30 * 60);
    logger.info(`theOddsApi: ${events.length} events for ${sportSlug}`);
    return events;
  } catch (err) {
    const status = err.response?.status;
    logger.warn(`theOddsApi: fetch failed [${status ?? 'no-response'}] ${err.message}`);
    return [];
  }
};

// ── Convert the-odds-api response to our internal odds format ─────────────────

const avgPrice = (outcomes, ...names) => {
  const prices = [];
  for (const bm of outcomes) {
    for (const name of names) {
      const o = bm.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (o && !isNaN(parseFloat(o.price))) prices.push(parseFloat(o.price));
    }
  }
  if (!prices.length) return null;
  return parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2));
};

const buildOddsFromEvent = (event, homeTeam, awayTeam) => {
  if (!event?.bookmakers?.length) return { found: false };

  // Collect outcomes per market across all bookmakers
  const markets = {}; // key → [ [outcome, ...], ... ]  (array per bookmaker)
  for (const bm of event.bookmakers) {
    for (const market of bm.markets || []) {
      if (!markets[market.key]) markets[market.key] = [];
      markets[market.key].push(market.outcomes || []);
    }
  }

  // ── 1X2 / h2h ────────────────────────────────────────────────────────────────
  const h2hBms = markets.h2h || [];
  const h2hHome = avgPrice(h2hBms, homeTeam, event.home_team);
  const h2hDraw = avgPrice(h2hBms, 'Draw');
  const h2hAway = avgPrice(h2hBms, awayTeam, event.away_team);

  // ── Totals (goals over/under) ─────────────────────────────────────────────────
  const totalBms = markets.totals || [];
  const pts = new Set();
  for (const bm of totalBms) {
    for (const o of bm) {
      if (typeof o.point === 'number') pts.add(o.point);
    }
  }
  const totals = [...pts].sort((a, b) => a - b).map((pt) => {
    const overPrices  = [];
    const underPrices = [];
    for (const bm of totalBms) {
      for (const o of bm) {
        if (o.point !== pt) continue;
        const price = parseFloat(o.price);
        if (isNaN(price)) continue;
        if (o.name.toLowerCase() === 'over')  overPrices.push(price);
        if (o.name.toLowerCase() === 'under') underPrices.push(price);
      }
    }
    const avg = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
    return { point: pt, over: avg(overPrices), under: avg(underPrices) };
  }).filter((t) => t.over || t.under);

  // ── BTTS ──────────────────────────────────────────────────────────────────────
  const bttsBms = markets.btts || [];
  const bttsYes = avgPrice(bttsBms, 'Yes');
  const bttsNo  = avgPrice(bttsBms, 'No');

  // ── Double chance ─────────────────────────────────────────────────────────────
  const dcBms = markets.double_chance || [];
  const dcHomeDraw = avgPrice(dcBms, 'Home/Draw');
  const dcHomeAway = avgPrice(dcBms, 'Home/Away');
  const dcDrawAway = avgPrice(dcBms, 'Draw/Away');

  // ── Spreads (Asian handicap) ──────────────────────────────────────────────────
  const spreadBms = markets.spreads || [];
  const hcapPts = new Set();
  for (const bm of spreadBms) {
    for (const o of bm) {
      if (typeof o.point === 'number') hcapPts.add(o.point);
    }
  }
  const spreads = {};
  for (const pt of hcapPts) {
    const homePrices = [];
    const awayPrices = [];
    for (const bm of spreadBms) {
      for (const o of bm) {
        if (o.point !== pt) continue;
        const price = parseFloat(o.price);
        if (isNaN(price)) continue;
        const nm = o.name.toLowerCase();
        if (nm === event.home_team.toLowerCase() || teamsMatch(nm, homeTeam)) homePrices.push(price);
        if (nm === event.away_team.toLowerCase() || teamsMatch(nm, awayTeam)) awayPrices.push(price);
      }
    }
    const avg = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
    const h = avg(homePrices);
    const a = avg(awayPrices);
    if (h || a) spreads[String(pt)] = { home: h, away: a };
  }

  return {
    found:        true,
    h2h:          (h2hHome || h2hDraw || h2hAway) ? { home: h2hHome, draw: h2hDraw, away: h2hAway } : null,
    totals:       totals.length ? totals : null,
    btts:         (bttsYes || bttsNo) ? { yes: bttsYes, no: bttsNo } : null,
    doubleChance: (dcHomeDraw || dcHomeAway || dcDrawAway) ? { homeDraw: dcHomeDraw, homeAway: dcHomeAway, drawAway: dcDrawAway } : null,
    spreads:      Object.keys(spreads).length ? spreads : null,
    ht:           null,
    htTotals:     null,
    cornersOu:    null,
    corners1x2:   null,
    cardsOu:      null,
  };
};

// ── Public: get odds by team names + kickoff + league ─────────────────────────

/**
 * @param {string} homeTeam   - home team name
 * @param {string} awayTeam   - away team name
 * @param {string} kickoff    - ISO date string (used for date matching)
 * @param {string} leagueName - league name (used to determine the-odds-api sport slug)
 */
const getOddsForMatch = async (homeTeam, awayTeam, kickoff, leagueName = '') => {
  const sportSlug = getOddsSportSlug(leagueName);
  const events    = await fetchSportEvents(sportSlug);

  if (!events.length) return { found: false };

  const kickoffDay = (kickoff ?? '').slice(0, 10);

  const match = events.find((e) => {
    const eDay = (e.commence_time ?? '').slice(0, 10);
    if (eDay !== kickoffDay) return false;
    return teamsMatch(e.home_team, homeTeam) && teamsMatch(e.away_team, awayTeam);
  });

  if (!match) {
    logger.info(`theOddsApi: no match for ${homeTeam} vs ${awayTeam} on ${kickoffDay} (${sportSlug})`);
    return { found: false };
  }

  return buildOddsFromEvent(match, homeTeam, awayTeam);
};

module.exports = { getOddsForMatch };
