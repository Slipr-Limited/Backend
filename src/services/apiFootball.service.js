/**
 * services/apiFootball.service.js — Dual-source football fixture search.
 *
 * Football searches hit BOTH APIs in parallel and merge results:
 *   • football-data.org  (fd_)  — EPL, La Liga, Bundesliga, Serie A, Ligue 1, CL, EL, etc.
 *   • api-sports.io      (as_)  — J-League, African, Asian, American leagues + any others
 *
 * fixtureId encoding:
 *   fd_<number>  → football-data.org match
 *   as_<number>  → api-sports fixture  (legacy plain numbers also treated as as_)
 *
 * Basketball / Baseball use api-sports only (no alternative free source exists).
 *
 * Exports:
 *   searchFixtures(date, query, sport)
 *   searchFixturesRange(dateFrom, dateTo, query, sport)
 *   getFixtureResult(fixtureId, sport)
 *   resolveSelection(selection, result)
 */

'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');

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

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE A — football-data.org  (prefix: fd_)
// ═══════════════════════════════════════════════════════════════════════════════

const fdClient = () => axios.create({
  baseURL: 'https://api.football-data.org/v4',
  headers: { 'X-Auth-Token': process.env.FOOTBALL_DATA_KEY },
  timeout: 15000,
});

const FD_FINISHED = new Set(['FINISHED', 'AWARDED']);

// Known league aliases → { label, fdCodes, asIds }
// label:   canonical display name shown to users regardless of which API returned it
// fdCodes: exact football-data.org competition codes
// asIds:   exact api-sports league IDs
// When a query matches an alias we filter by ID/code ONLY — no substring fallback.
// This prevents "Premier League 2", "La Liga SmartBank" etc. leaking through.
const LEAGUE_ALIASES = {
  'premier league':    { label: 'Premier League',    fdCodes: ['pl'],  asIds: [39]  },
  'epl':               { label: 'Premier League',    fdCodes: ['pl'],  asIds: [39]  },
  'la liga':           { label: 'La Liga',            fdCodes: ['pd'],  asIds: [140] },
  'laliga':            { label: 'La Liga',            fdCodes: ['pd'],  asIds: [140] },
  'primera division':  { label: 'La Liga',            fdCodes: ['pd'],  asIds: [140] },
  'bundesliga':        { label: 'Bundesliga',         fdCodes: ['bl1'], asIds: [78]  },
  'serie a':           { label: 'Serie A',            fdCodes: ['sa'],  asIds: [135] },
  'ligue 1':           { label: 'Ligue 1',            fdCodes: ['fl1'], asIds: [61]  },
  'ligue1':            { label: 'Ligue 1',            fdCodes: ['fl1'], asIds: [61]  },
  'eredivisie':        { label: 'Eredivisie',         fdCodes: ['ded'], asIds: [88]  },
  'primeira liga':     { label: 'Primeira Liga',      fdCodes: ['ppl'], asIds: [94]  },
  'liga nos':          { label: 'Primeira Liga',      fdCodes: ['ppl'], asIds: [94]  },
  'brasileirao':       { label: 'Brasileirão',        fdCodes: ['bsa'], asIds: [71]  },
  'champions league':  { label: 'Champions League',   fdCodes: ['cl'],  asIds: [2]   },
  'ucl':               { label: 'Champions League',   fdCodes: ['cl'],  asIds: [2]   },
  'europa league':     { label: 'Europa League',      fdCodes: ['el'],  asIds: [3]   },
  'uel':               { label: 'Europa League',      fdCodes: ['el'],  asIds: [3]   },
  'conference league': { label: 'Conference League',  fdCodes: [],      asIds: [848] },
  'uecl':              { label: 'Conference League',  fdCodes: [],      asIds: [848] },
  'nations league':    { label: 'Nations League',     fdCodes: [],      asIds: [5]   },
  'world cup':         { label: 'World Cup',          fdCodes: [],      asIds: [1]   },
  'copa libertadores': { label: 'Copa Libertadores',  fdCodes: [],      asIds: [13]  },
  'afcon':             { label: 'AFCON',              fdCodes: [],      asIds: [6]   },
};

const mapFdFixture = (m) => ({
  fixtureId:  `fd_${m.id}`,
  homeTeam:   m.homeTeam?.shortName ?? m.homeTeam?.name ?? 'Home',
  awayTeam:   m.awayTeam?.shortName ?? m.awayTeam?.name ?? 'Away',
  kickoff:    m.utcDate,
  league:     m.competition?.name ?? '',
  leagueCode: (m.competition?.code ?? '').toLowerCase(),
  country:    m.area?.name ?? '',
  status:     m.status,
});

const searchFd = async (date, query = '') => {
  const cacheKey = `fd:search:${date}`;
  let all = await cacheGet(cacheKey);

  if (!all) {
    try {
      const { data } = await fdClient().get('/matches', { params: { date } });
      all = (data.matches || []).map(mapFdFixture);
      if (all.length > 0) await cacheSet(cacheKey, all, 30 * 60);
      logger.info(`fd: ${all.length} fixtures on ${date}`);
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 401 || err.response?.status === 400) {
        logger.error('football-data.org auth error:', err.response?.data?.message);
        return [];
      }
      logger.warn('fd search failed:', err.message);
      return [];
    }
  }

  if (!query) return all;
  const q     = query.toLowerCase().trim();
  const alias = LEAGUE_ALIASES[q];

  if (alias) {
    // Known league: match ONLY by exact competition code — never fall through to text
    if (!alias.fdCodes.length) return []; // league not covered by football-data.org
    return all.filter((f) => alias.fdCodes.includes((f.leagueCode ?? '').toLowerCase()));
  }

  // Free-text search: match league name or team names (no country — too broad)
  return all.filter((f) => {
    const league = (f.league   ?? '').toLowerCase();
    const home   = (f.homeTeam ?? '').toLowerCase();
    const away   = (f.awayTeam ?? '').toLowerCase();
    return league.includes(q) || home.includes(q) || away.includes(q);
  });
};

const getFdResult = async (numericId) => {
  const cacheKey = `fd:result:${numericId}`;
  const cached   = await cacheGet(cacheKey);
  if (cached?.isFinished) return cached;

  try {
    const { data } = await fdClient().get(`/matches/${numericId}`);
    const m          = data;
    const homeScore  = m.score?.fullTime?.home ?? null;
    const awayScore  = m.score?.fullTime?.away ?? null;
    const isFinished = FD_FINISHED.has(m.status);
    const winner     = homeScore === null ? null
      : homeScore > awayScore ? 'home'
      : awayScore > homeScore ? 'away'
      : 'draw';
    const htHome = m.score?.halfTime?.home ?? null;
    const htAway = m.score?.halfTime?.away ?? null;
    const result = { status: m.status, homeScore, awayScore, winner, isFinished, htHome, htAway };
    await cacheSet(cacheKey, result, isFinished ? 60 * 60 : 5 * 60);
    return result;
  } catch (err) {
    logger.warn('fd getResult failed:', err.message);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE B — api-sports.io  (prefix: as_)
// ═══════════════════════════════════════════════════════════════════════════════

const FOOTBALL_FINISHED   = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']);
const BASKETBALL_FINISHED = new Set(['FT', 'FT/OT', 'FT/OT2', 'FT/SO', 'AOT']);
const BASEBALL_FINISHED   = new Set(['FT', 'Finished', 'FIN']);

const AS_CONFIGS = {
  football: {
    baseURL: 'https://v3.football.api-sports.io',
    path:    '/fixtures',
    finished: FOOTBALL_FINISHED,
    mapFixture: (f) => ({
      fixtureId: `as_${f.fixture.id}`,
      homeTeam:  f.teams.home.name,
      awayTeam:  f.teams.away.name,
      kickoff:   f.fixture.date,
      league:    f.league.name,
      leagueId:  f.league.id,
      country:   f.league.country,
      status:    f.fixture.status.short,
    }),
    mapResult: (f) => {
      const homeScore  = f.goals.home ?? null;
      const awayScore  = f.goals.away ?? null;
      const htHome     = f.score?.halftime?.home ?? null;
      const htAway     = f.score?.halftime?.away ?? null;
      const isFinished = FOOTBALL_FINISHED.has(f.fixture.status.short);
      const winner     = homeScore === null ? null
        : homeScore > awayScore ? 'home'
        : awayScore > homeScore ? 'away'
        : 'draw';
      return { status: f.fixture.status.short, homeScore, awayScore, winner, isFinished, htHome, htAway };
    },
  },
  basketball: {
    baseURL: 'https://v3.basketball.api-sports.io',
    path:    '/games',
    finished: BASKETBALL_FINISHED,
    mapFixture: (g) => ({
      fixtureId: `as_${g.id}`,
      homeTeam:  g.teams.home.name,
      awayTeam:  g.teams.visitors.name,
      kickoff:   g.date,
      league:    g.league.name,
      country:   g.country?.name ?? '',
      status:    g.status.short,
    }),
    mapResult: (g) => {
      const homeScore  = g.scores?.home?.total ?? null;
      const awayScore  = g.scores?.visitors?.total ?? null;
      const isFinished = BASKETBALL_FINISHED.has(g.status.short);
      const winner     = homeScore === null ? null
        : homeScore > awayScore ? 'home'
        : awayScore > homeScore ? 'away'
        : 'draw';
      return { status: g.status.short, homeScore, awayScore, winner, isFinished };
    },
  },
  baseball: {
    baseURL: 'https://v3.baseball.api-sports.io',
    path:    '/games',
    finished: BASEBALL_FINISHED,
    mapFixture: (g) => ({
      fixtureId: `as_${g.id}`,
      homeTeam:  g.teams.home.name,
      awayTeam:  g.teams.away?.name ?? g.teams.visitors?.name ?? '—',
      kickoff:   g.date,
      league:    g.league.name,
      country:   g.country?.name ?? '',
      status:    g.status.short,
    }),
    mapResult: (g) => {
      const homeScore  = g.scores?.home?.total ?? null;
      const awayScore  = (g.scores?.away ?? g.scores?.visitors)?.total ?? null;
      const isFinished = BASEBALL_FINISHED.has(g.status.short);
      const winner     = homeScore === null ? null
        : homeScore > awayScore ? 'home'
        : awayScore > homeScore ? 'away'
        : 'draw';
      return { status: g.status.short, homeScore, awayScore, winner, isFinished };
    },
  },
};

const asClient = (sport) => axios.create({
  baseURL: AS_CONFIGS[sport].baseURL,
  headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY },
  timeout: 12000,
});

const searchAs = async (date, query = '', sport = 'football') => {
  const cfg      = AS_CONFIGS[sport];
  const cacheKey = `as:search:${sport}:${date}`;
  let all        = await cacheGet(cacheKey);

  if (!all) {
    try {
      const { data } = await asClient(sport).get(cfg.path, {
        params: { date, timezone: 'Africa/Lagos' },
      });
      all = (data.response || []).map(cfg.mapFixture);
      if (all.length > 0) await cacheSet(cacheKey, all, 30 * 60);
      logger.info(`as.${sport}: ${all.length} fixtures on ${date}`);
    } catch (err) {
      logger.warn(`as.${sport} search failed:`, err.message);
      return [];
    }
  }

  if (!query) return all;
  const q     = query.toLowerCase().trim();
  const alias = sport === 'football' ? LEAGUE_ALIASES[q] : null;

  if (alias) {
    // Known league: filter by exact api-sports league ID — zero false positives
    if (!alias.asIds.length) return [];
    return all.filter((f) => alias.asIds.includes(f.leagueId));
  }

  // Free-text: match league name or team names (not country — too broad)
  return all.filter((f) =>
    (f.league   ?? '').toLowerCase().includes(q) ||
    (f.homeTeam ?? '').toLowerCase().includes(q) ||
    (f.awayTeam ?? '').toLowerCase().includes(q),
  );
};

const getAsResult = async (numericId, sport = 'football') => {
  const cfg      = AS_CONFIGS[sport] ?? AS_CONFIGS.football;
  const cacheKey = `as:result:${sport}:${numericId}`;
  const cached   = await cacheGet(cacheKey);
  if (cached?.isFinished) return cached;

  try {
    const { data }   = await asClient(sport).get(cfg.path, { params: { id: numericId } });
    const item       = data.response?.[0];
    if (!item) return null;
    const result = cfg.mapResult(item);
    await cacheSet(cacheKey, result, result.isFinished ? 60 * 60 : 5 * 60);
    return result;
  } catch (err) {
    logger.warn('as getResult failed:', err.message);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// MERGED FOOTBALL SEARCH — both APIs in parallel, deduplicated
// ═══════════════════════════════════════════════════════════════════════════════

// Known short-name → normalised form for common clubs where fd_ abbreviates
// and as_ uses the full name (e.g. "Man City" vs "Manchester City").
const TEAM_ALIASES = {
  'man city':          'manchestercity',
  'man utd':           'manchesterunited',
  'man united':        'manchesterunited',
  'manchester utd':    'manchesterunited',
  'spurs':             'tottenham',
  'wolves':            'wolverhampton',
  'villa':             'astonvilla',
  'newcastle utd':     'newcastleunited',
  'newcastle':         'newcastleunited',
  'brighton':          'brightonandhovealbion',
  'west ham':          'westham',
  'west brom':         'westbromwich',
  'sheff utd':         'sheffieldunited',
  'sheff wed':         'sheffieldwednesday',
  'nott\'m forest':    'nottinghamforest',
  'nottm forest':      'nottinghamforest',
  'atlético madrid':   'atleticomadrid',
  'atletico madrid':   'atleticomadrid',
  'real betis':        'realbetis',
  'celta vigo':        'celtavigo',
  'real sociedad':     'realsociedad',
  'inter milan':       'inter',
  'ac milan':          'milan',
  'as roma':           'roma',
  'psg':               'parissaintgermain',
  'paris sg':          'parissaintgermain',
  'paris saint-germain': 'parissaintgermain',
  'rb leipzig':        'rbleipzig',
  'leverkusen':        'bayerleverkusen',
  'bayer leverkusen':  'bayerleverkusen',
};

/**
 * Normalise a team name for dedup — strips non-alpha chars and resolves
 * known abbreviations so "Man City" and "Manchester City" produce the same key.
 */
const normalizeTeam = (name) => {
  const lower = (name ?? '').toLowerCase().trim();
  if (TEAM_ALIASES[lower]) return TEAM_ALIASES[lower];
  return lower
    .replace(/\b(fc|cf|sc|ac|as|bv|sv|rsc|sk|fk)\b\.?/g, '') // remove club-type tokens
    .replace(/[^a-z0-9]/g, '')                                  // strip all punctuation/spaces
    .slice(0, 12);
};

const dedupKey = (f) => {
  const home = normalizeTeam(f.homeTeam);
  const away = normalizeTeam(f.awayTeam);
  const day  = (f.kickoff ?? '').slice(0, 10);
  const hour = (f.kickoff ?? '').slice(11, 13); // same-hour guard for double-headers
  return `${home}|${away}|${day}|${hour}`;
};

const searchFootballBoth = async (date, query = '') => {
  const q     = (query || '').toLowerCase().trim();
  const alias = LEAGUE_ALIASES[q];

  // ── Known league → single API to prevent cross-source duplicates ──────────
  // football-data.org uses short team names ("Man City"); api-sports uses full
  // names ("Manchester City"). Merging both for the same league always produces
  // duplicates because dedup cannot reliably match short vs full names.
  // We also stamp every fixture with the canonical label (e.g. "La Liga" instead
  // of fd_'s internal name "Primera Division").
  if (alias) {
    const stamp = (fixtures) =>
      alias.label ? fixtures.map((f) => ({ ...f, league: alias.label })) : fixtures;

    if (alias.fdCodes.length > 0) {
      return stamp(await searchFd(date, query));
    }
    return stamp(await searchAs(date, query, 'football'));
  }

  // ── Free-text team/league search → merge both APIs ────────────────────────
  const [fdResults, asResults] = await Promise.all([
    searchFd(date, query),
    searchAs(date, query, 'football'),
  ]);

  // Prefer fd_ entries; add as_ only when genuinely absent
  const seen = new Map();
  for (const f of fdResults) seen.set(dedupKey(f), f);
  for (const f of asResults) {
    const k = dedupKey(f);
    if (!seen.has(k)) seen.set(k, f);
  }

  return [...seen.values()].sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
};

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

const searchFixtures = async (date, query = '', sport = 'football') => {
  if (sport === 'football') return searchFootballBoth(date, query);
  if (AS_CONFIGS[sport])    return searchAs(date, query, sport);
  return [];
};

const searchFixturesRange = async (dateFrom, dateTo, query = '', sport = 'football') => {
  const from     = new Date(dateFrom);
  const to       = new Date(dateTo);
  const dayCount = Math.round((to - from) / 86_400_000) + 1;

  if (dayCount < 1)  return searchFixtures(dateFrom, query, sport);
  if (dayCount > 14) throw new Error('Date range cannot exceed 14 days');

  const dates = Array.from({ length: dayCount }, (_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  const perDay = await Promise.all(dates.map((d) => searchFixtures(d, query, sport)));

  const seen = new Set();
  return perDay
    .flat()
    .filter((f) => {
      // Use fixtureId for exact-same-source dups, plus dedupKey for cross-source dups
      const key = `${f.fixtureId}|${dedupKey(f)}`;
      if (seen.has(f.fixtureId) || seen.has(dedupKey(f))) return false;
      seen.add(f.fixtureId);
      seen.add(dedupKey(f));
      return true;
    })
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
};

// ═══════════════════════════════════════════════════════════════════════════════
// MATCH STATISTICS — api-sports only (corners, cards)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch match statistics for a finished fixture.
 * Returns { corners: { home, away, total }, cards: { yellow, red, total } }
 * Only works for as_ fixtures (football-data.org has no stats endpoint).
 */
const getMatchStatistics = async (fixtureId) => {
  const id = String(fixtureId ?? '');
  let numericId;

  if (id.startsWith('as_'))      numericId = id.slice(3);
  else if (id.startsWith('fd_')) return null; // not available via football-data.org
  else                           numericId = id;

  const cacheKey = `as:stats:${numericId}`;
  const cached   = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await asClient('football').get('/fixtures/statistics', {
      params: { fixture: numericId },
    });

    const teams = data.response || [];
    if (teams.length < 2) return null;

    const getStat = (team, typeName) => {
      const s = team.statistics?.find((st) => st.type === typeName);
      return s?.value ?? 0;
    };

    const [home, away] = teams;
    const homeCorners = getStat(home, 'Corner Kicks');
    const awayCorners = getStat(away, 'Corner Kicks');
    const homeYellow  = getStat(home, 'Yellow Cards');
    const awayYellow  = getStat(away, 'Yellow Cards');
    const homeRed     = getStat(home, 'Red Cards');
    const awayRed     = getStat(away, 'Red Cards');

    const result = {
      corners: {
        home:  homeCorners,
        away:  awayCorners,
        total: homeCorners + awayCorners,
      },
      cards: {
        yellow: homeYellow + awayYellow,
        red:    homeRed + awayRed,
        total:  homeYellow + awayYellow + homeRed + awayRed,
        home:   homeYellow + homeRed,
        away:   awayYellow + awayRed,
      },
    };

    await cacheSet(cacheKey, result, 60 * 60);
    return result;
  } catch (err) {
    logger.warn('as getStatistics failed:', err.message);
    return null;
  }
};

/**
 * Route result lookup to the correct API based on fixtureId prefix.
 *   fd_<n>  → football-data.org
 *   as_<n>  → api-sports
 *   <n>     → api-sports (legacy, no prefix)
 */
const getFixtureResult = async (fixtureId, sport = 'football') => {
  const id = String(fixtureId);

  if (id.startsWith('fd_')) {
    return getFdResult(id.slice(3));
  }

  const numericId = id.startsWith('as_') ? id.slice(3) : id;
  return getAsResult(numericId, sport);
};

// ── resolveSelection — resolves a bet selection against match result + stats ──

const resolveSelection = (selection, result, stats = null) => {
  const { homeScore, awayScore, winner, htHome, htAway } = result;
  if (homeScore === null || awayScore === null) return 'void';

  const total = homeScore + awayScore;

  switch (selection) {
    // ── 1X2 ──────────────────────────────────────────────────────────────────
    case '1':
    case 'home':           return winner === 'home'  ? 'won' : 'lost';
    case 'X':             return winner === 'draw'  ? 'won' : 'lost';
    case '2':
    case 'away':           return winner === 'away'  ? 'won' : 'lost';

    // ── Double chance ─────────────────────────────────────────────────────────
    case '1X':            return winner !== 'away'  ? 'won' : 'lost';
    case '12':            return homeScore !== awayScore ? 'won' : 'lost';
    case 'X2':            return winner !== 'home'  ? 'won' : 'lost';

    // ── BTTS ─────────────────────────────────────────────────────────────────
    case 'btts_yes':
    case 'gg':            return homeScore > 0 && awayScore > 0 ? 'won' : 'lost';
    case 'btts_no':
    case 'ng':            return homeScore === 0 || awayScore === 0 ? 'won' : 'lost';

    // ── Team scoring ─────────────────────────────────────────────────────────
    case 'home_score':    return homeScore > 0 ? 'won' : 'lost';
    case 'away_score':    return awayScore > 0 ? 'won' : 'lost';
    case 'any_team_2plus':return (homeScore >= 2 || awayScore >= 2) ? 'won' : 'lost';
    case 'any_team_3plus':return (homeScore >= 3 || awayScore >= 3) ? 'won' : 'lost';

    default: {
      // ── Goals over/under ───────────────────────────────────────────────────
      if (selection.startsWith('over_'))       { const t = parseFloat(selection.slice(5));  return isNaN(t) ? 'void' : total     > t ? 'won' : 'lost'; }
      if (selection.startsWith('under_'))      { const t = parseFloat(selection.slice(6));  return isNaN(t) ? 'void' : total     < t ? 'won' : 'lost'; }
      if (selection.startsWith('home_over_'))  { const t = parseFloat(selection.slice(10)); return isNaN(t) ? 'void' : homeScore > t ? 'won' : 'lost'; }
      if (selection.startsWith('home_under_')) { const t = parseFloat(selection.slice(11)); return isNaN(t) ? 'void' : homeScore < t ? 'won' : 'lost'; }
      if (selection.startsWith('away_over_'))  { const t = parseFloat(selection.slice(10)); return isNaN(t) ? 'void' : awayScore > t ? 'won' : 'lost'; }
      if (selection.startsWith('away_under_')) { const t = parseFloat(selection.slice(11)); return isNaN(t) ? 'void' : awayScore < t ? 'won' : 'lost'; }

      // ── Asian handicap (hcap_home_X / hcap_away_X) ────────────────────────
      // X is the handicap applied to that team's score before comparing.
      // Fractional handicaps (-0.5, +0.5) can never push; whole numbers can.
      if (selection.startsWith('hcap_home_')) {
        const hcap = parseFloat(selection.replace('hcap_home_', ''));
        if (isNaN(hcap)) return 'void';
        const adj = homeScore + hcap;
        if (adj > awayScore) return 'won';
        if (adj < awayScore) return 'lost';
        return 'void'; // push — refund
      }
      if (selection.startsWith('hcap_away_')) {
        const hcap = parseFloat(selection.replace('hcap_away_', ''));
        if (isNaN(hcap)) return 'void';
        const adj = awayScore + hcap;
        if (adj > homeScore) return 'won';
        if (adj < homeScore) return 'lost';
        return 'void'; // push
      }

      // ── Half-time result & totals ─────────────────────────────────────────
      if (selection === 'ht_1') {
        if (htHome === null || htAway === null) return 'void';
        return htHome > htAway ? 'won' : 'lost';
      }
      if (selection === 'ht_x') {
        if (htHome === null || htAway === null) return 'void';
        return htHome === htAway ? 'won' : 'lost';
      }
      if (selection === 'ht_2') {
        if (htHome === null || htAway === null) return 'void';
        return htAway > htHome ? 'won' : 'lost';
      }
      if (selection.startsWith('ht_over_')) {
        const t = parseFloat(selection.slice(8));
        if (isNaN(t) || htHome === null || htAway === null) return 'void';
        return (htHome + htAway) > t ? 'won' : 'lost';
      }
      if (selection.startsWith('ht_under_')) {
        const t = parseFloat(selection.slice(9));
        if (isNaN(t) || htHome === null || htAway === null) return 'void';
        return (htHome + htAway) < t ? 'won' : 'lost';
      }

      // ── Corners ──────────────────────────────────────────────────────────────
      if (selection.startsWith('corners_')) {
        if (!stats?.corners) return 'unresolvable';
        const { corners } = stats;
        if (selection.startsWith('corners_over_')) {
          const t = parseFloat(selection.slice(13));
          return isNaN(t) ? 'void' : corners.total > t ? 'won' : 'lost';
        }
        if (selection.startsWith('corners_under_')) {
          const t = parseFloat(selection.slice(14));
          return isNaN(t) ? 'void' : corners.total < t ? 'won' : 'lost';
        }
        if (selection === 'corners_home') return corners.home > corners.away ? 'won' : 'lost';
        if (selection === 'corners_away') return corners.away > corners.home ? 'won' : 'lost';
        if (selection === 'corners_draw') return corners.home === corners.away ? 'won' : 'lost';
        return 'void';
      }

      // ── Cards ─────────────────────────────────────────────────────────────────
      if (selection.startsWith('cards_')) {
        if (!stats?.cards) return 'unresolvable';
        const { cards } = stats;
        if (selection.startsWith('cards_over_')) {
          const t = parseFloat(selection.slice(11));
          return isNaN(t) ? 'void' : cards.total > t ? 'won' : 'lost';
        }
        if (selection.startsWith('cards_under_')) {
          const t = parseFloat(selection.slice(12));
          return isNaN(t) ? 'void' : cards.total < t ? 'won' : 'lost';
        }
        if (selection === 'cards_home') return cards.home > 0 ? 'won' : 'lost';
        if (selection === 'cards_away') return cards.away > 0 ? 'won' : 'lost';
        if (selection === 'cards_both') return cards.home > 0 && cards.away > 0 ? 'won' : 'lost';
        return 'void';
      }

      return 'void'; // truly unknown selection string
    }
  }
};

module.exports = { searchFixtures, searchFixturesRange, getFixtureResult, getMatchStatistics, resolveSelection };
