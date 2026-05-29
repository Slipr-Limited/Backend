/**
 * services/odds.service.js — Live odds from api-sports.io (paid plan).
 *
 * Endpoint: GET https://v3.football.api-sports.io/odds?fixture=<id>
 *
 * For as_ fixtures: numeric ID used directly.
 * For fd_ fixtures: cross-reference via /fixtures?date=<date> + team name match.
 */

'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

const AS_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

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
  try { await r.set(key, JSON.stringify(data), 'EX', ttl); } catch { /* non-fatal */ }
};

// ── Team name normalisation ───────────────────────────────────────────────────
// Reuse the same normalizeTeam (with TEAM_ALIASES) used for fixture dedup so
// abbreviations like PSG → parissaintgermain are resolved consistently.

const { normalizeTeam } = require('./apiFootball.service');

const teamsMatch = (a, b) => {
  const na = normalizeTeam(a);
  const nb = normalizeTeam(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
};

// ── api-sports client ─────────────────────────────────────────────────────────

const asClient = () => axios.create({
  baseURL: AS_FOOTBALL_BASE,
  headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY },
  timeout: 12000,
});

// ── Flexible bet finder — tries exact names, then substring match ─────────────
// Pass multiple candidate names; first match wins.

const findBet = (bets, ...names) => {
  if (!bets?.length) return null;
  // Try exact match across all names first
  for (const name of names) {
    const lo = name.toLowerCase();
    const hit = bets.find((b) => b.name.toLowerCase() === lo);
    if (hit) return hit;
  }
  // Fall back to substring match (handles "Goals Over/Under" vs "Total Goals Over/Under")
  for (const name of names) {
    const lo = name.toLowerCase();
    const hit = bets.find((b) => b.name.toLowerCase().includes(lo) || lo.includes(b.name.toLowerCase()));
    if (hit) return hit;
  }
  return null;
};

// ── Average odd from all bookmakers for a specific bet + outcome ───────────────

const avgBetOdd = (bookmakers, betNames, outcomeValue) => {
  const names  = Array.isArray(betNames) ? betNames : [betNames];
  const prices = [];

  for (const bm of bookmakers) {
    const bet = findBet(bm.bets, ...names);
    if (!bet) continue;
    for (const v of bet.values || []) {
      if (v.value.toLowerCase() !== outcomeValue.toLowerCase()) continue;
      const price = parseFloat(v.odd);
      if (!isNaN(price)) prices.push(price);
    }
  }
  if (!prices.length) return null;
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return parseFloat(avg.toFixed(2));
};

// ── Parse over/under bets (values "Over 2.5", "Under 2.5", or whole "Over 8") ──
// Accepts multiple candidate bet names; tries each until one has data.

const parseTotals = (bookmakers, ...betNames) => {
  const pts = new Set();

  for (const bm of bookmakers) {
    const bet = findBet(bm.bets, ...betNames);
    if (!bet) continue;
    for (const v of bet.values || []) {
      const m = v.value.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
      if (m) pts.add(parseFloat(m[2]));
    }
  }

  return [...pts].sort((a, b) => a - b).map((pt) => {
    // Build canonical strings: try both "Over 8.5" and "Over 8" (whole number case)
    const overKey  = pt % 1 === 0 ? [`Over ${pt}`, `Over ${pt}.0`] : [`Over ${pt}`];
    const underKey = pt % 1 === 0 ? [`Under ${pt}`, `Under ${pt}.0`] : [`Under ${pt}`];

    const overPrices  = [];
    const underPrices = [];
    for (const bm of bookmakers) {
      const bet = findBet(bm.bets, ...betNames);
      if (!bet) continue;
      for (const v of bet.values || []) {
        const price = parseFloat(v.odd);
        if (isNaN(price)) continue;
        const lo = v.value.toLowerCase();
        if (overKey.some((k)  => lo === k.toLowerCase())) overPrices.push(price);
        if (underKey.some((k) => lo === k.toLowerCase())) underPrices.push(price);
      }
    }
    const avg = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
    return { point: pt, over: avg(overPrices), under: avg(underPrices) };
  }).filter((t) => t.over || t.under);
};

// ── Parse Asian Handicap ───────────────────────────────────────────────────────
// api-sports ACTUAL format (confirmed): value = "Home -0.5" / "Away +0.25"
// The `handicap` field on each value object is ALWAYS EMPTY — handicap is in the
// value string itself. Parse it with a regex.
//
// Spreads object keyed by the handicap float (e.g. "-0.5", "0.25").
// spreads["-0.5"] = { home: 2.75, away: 1.42 }
//   → hcap_home_-0.5 uses .home, hcap_away_-0.5 uses .away

const parseSpreads = (bookmakers) => {
  // { key → { homePrices, awayPrices } }
  const map = {};

  for (const bm of bookmakers) {
    const bet = findBet(bm.bets, 'asian handicap');
    if (!bet) continue;
    for (const v of bet.values || []) {
      // e.g. "Home -0.5", "Away +0.25", "Home +0", "Away -1.75"
      const m = v.value.match(/^(Home|Away)\s+([+-]?\d+(?:\.\d+)?)$/i);
      if (!m) continue;
      const team  = m[1].toLowerCase(); // 'home' or 'away'
      const pt    = parseFloat(m[2]);
      const key   = String(pt);
      const price = parseFloat(v.odd);
      if (isNaN(price)) continue;
      if (!map[key]) map[key] = { homePrices: [], awayPrices: [] };
      if (team === 'home') map[key].homePrices.push(price);
      else                 map[key].awayPrices.push(price);
    }
  }

  const avg = (arr) => arr.length ? parseFloat((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null;
  const spreads = {};
  for (const [key, { homePrices, awayPrices }] of Object.entries(map)) {
    const h = avg(homePrices);
    const a = avg(awayPrices);
    if (h || a) spreads[key] = { home: h, away: a };
  }
  return Object.keys(spreads).length ? spreads : null;
};

// ── Build full structured odds object from api-sports response ────────────────

const buildOdds = (entry) => {
  const bms = entry.bookmakers || [];
  if (!bms.length) return { found: false };

  // 1X2
  const h2hHome = avgBetOdd(bms, ['match winner', '1x2', 'match result'], 'home');
  const h2hDraw = avgBetOdd(bms, ['match winner', '1x2', 'match result'], 'draw');
  const h2hAway = avgBetOdd(bms, ['match winner', '1x2', 'match result'], 'away');

  // Goals over/under
  const totals = parseTotals(bms, 'goals over/under', 'over/under', 'total goals');

  // BTTS
  const bttsYes = avgBetOdd(bms, ['both teams score', 'both teams to score', 'gg/ng', 'btts'], 'yes');
  const bttsNo  = avgBetOdd(bms, ['both teams score', 'both teams to score', 'gg/ng', 'btts'], 'no');

  // Double chance
  const dcHomeDraw = avgBetOdd(bms, ['double chance'], 'home/draw');
  const dcHomeAway = avgBetOdd(bms, ['double chance'], 'home/away');
  const dcDrawAway = avgBetOdd(bms, ['double chance'], 'draw/away');

  // Asian handicap spreads
  const spreads = parseSpreads(bms);

  // Half-time
  const htHome   = avgBetOdd(bms, ['first half winner', 'half time', 'ht result', '1st half winner'], 'home');
  const htDraw   = avgBetOdd(bms, ['first half winner', 'half time', 'ht result', '1st half winner'], 'draw');
  const htAway   = avgBetOdd(bms, ['first half winner', 'half time', 'ht result', '1st half winner'], 'away');
  const htTotals = parseTotals(bms,
    'goals over/under first half',
    '1st half goals',
    'half time goals',
    'first half goals over/under',
  );

  // Corners — EXACT api-sports name is "Corners Over Under" (no slash, confirmed)
  // Also try "Home Corners Over/Under" / "Away Corners Over/Under" for team-specific
  const cornersOu = parseTotals(bms,
    'corners over under',       // ID 45 — exact name
    'corners over/under',       // fallback spelling
    'total corners',
  );

  // Corners 1x2 for home/draw/away corners winner
  const cornersHome = avgBetOdd(bms, ['corners 1x2'], 'home');
  const cornersDraw = avgBetOdd(bms, ['corners 1x2'], 'draw');
  const cornersAway = avgBetOdd(bms, ['corners 1x2'], 'away');

  // Cards — EXACT api-sports name is "Cards Over/Under" (ID 80, confirmed)
  const cardsOu = parseTotals(bms,
    'cards over/under',         // ID 80 — exact name
    'bookings over/under',
    'total bookings',
  );

  return {
    found:        true,
    h2h:          (h2hHome || h2hDraw || h2hAway) ? { home: h2hHome, draw: h2hDraw, away: h2hAway } : null,
    totals:       totals.length ? totals : null,
    btts:         (bttsYes || bttsNo) ? { yes: bttsYes, no: bttsNo } : null,
    doubleChance: (dcHomeDraw || dcHomeAway || dcDrawAway) ? { homeDraw: dcHomeDraw, homeAway: dcHomeAway, drawAway: dcDrawAway } : null,
    spreads,
    ht:           (htHome || htDraw || htAway) ? { home: htHome, draw: htDraw, away: htAway } : null,
    htTotals:     htTotals.length ? htTotals : null,
    cornersOu:    cornersOu.length ? cornersOu : null,
    corners1x2:   (cornersHome || cornersDraw || cornersAway) ? { home: cornersHome, draw: cornersDraw, away: cornersAway } : null,
    cardsOu:      cardsOu.length ? cardsOu : null,
  };
};

// ── Cross-reference: fd_ fixture → api-sports fixture ID ─────────────────────

const findAsFixtureId = async (kickoff, homeTeam, awayTeam) => {
  const date = (kickoff ?? '').slice(0, 10);
  if (!date) return null;

  const cacheKey = `odds:crossref:${date}`;
  let fixtures   = await cacheGet(cacheKey);

  if (!fixtures) {
    try {
      const { data } = await asClient().get('/fixtures', {
        params: { date, timezone: 'Africa/Lagos' },
      });
      fixtures = (data.response || []).map((f) => ({
        id:       f.fixture.id,
        homeTeam: f.teams.home.name,
        awayTeam: f.teams.away.name,
      }));
      if (fixtures.length > 0) await cacheSet(cacheKey, fixtures, 30 * 60);
    } catch (err) {
      logger.warn('odds: crossref fixture search failed:', err.message);
      return null;
    }
  }

  const match = fixtures.find(
    (f) => teamsMatch(f.homeTeam, homeTeam) && teamsMatch(f.awayTeam, awayTeam),
  );
  return match?.id ?? null;
};

// ── Fetch odds from api-sports by numeric fixture ID ─────────────────────────

const fetchAsOdds = async (numericId) => {
  const cacheKey = `odds:as:${numericId}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  if (!process.env.API_FOOTBALL_KEY) {
    logger.warn('odds: API_FOOTBALL_KEY not set');
    return null;
  }

  try {
    const { data } = await asClient().get('/odds', { params: { fixture: numericId } });

    const entry = data.response?.[0];
    if (!entry) {
      logger.info(`odds: no data for fixture ${numericId}`);
      const miss = { found: false };
      await cacheSet(cacheKey, miss, 30 * 60);
      return miss;
    }

    const result = buildOdds(entry);
    await cacheSet(cacheKey, result, 3 * 60 * 60);

    const markets = Object.keys(result).filter((k) => k !== 'found' && result[k]);
    logger.info(`odds: fixture ${numericId} — ${markets.join(', ')}`);
    return result;
  } catch (err) {
    const status = err.response?.status;
    logger.warn(`odds: fetch failed [${status ?? 'no-response'}] ${err.message}`);
    return null;
  }
};

// ── Public: get odds for a specific fixture ────────────────────────────────────

/**
 * @param {string} fixtureId  — 'as_592872', 'fd_375648', or bare numeric string
 * @param {string} kickoff    — ISO date string (needed for fd_ cross-reference)
 * @param {string} homeTeam   — home team name (needed for fd_ cross-reference)
 * @param {string} awayTeam   — away team name
 */
const getFixtureOdds = async (fixtureId, kickoff, homeTeam, awayTeam) => {
  const id = String(fixtureId ?? '');
  let numericId;

  if (id.startsWith('as_'))      numericId = id.slice(3);
  else if (id.startsWith('fd_')) {
    const asId = await findAsFixtureId(kickoff, homeTeam, awayTeam);
    if (!asId) {
      logger.info(`odds: no api-sports match for fd fixture ${id}`);
      return { found: false };
    }
    numericId = String(asId);
  } else if (id) {
    numericId = id;
  } else {
    return { found: false };
  }

  return (await fetchAsOdds(numericId)) ?? { found: false };
};

module.exports = { getFixtureOdds };
