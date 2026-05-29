'use strict';

/**
 * services/convertBetCodes.service.js
 * Wraps the Betpaddi API to convert a source booking code into
 * equivalent codes on all other supported Nigerian/African platforms.
 *
 * Docs: https://documenter.getpostman.com/view/17112744/2sB2qZFNfu
 * API key: set BETPADDI_API_KEY in .env
 * Get key: Log into betpaddi.com → Developer page → Generate API Key
 *
 * Auth header: X-API-Key
 * Base URL:    https://betpaddi.com/api/v1
 * Cost:        1 credit per conversion
 */

const axios  = require('axios');
const logger = require('../utils/logger');

const BASE_URL = 'https://betpaddi.com/api/v1';
const API_KEY  = process.env.BETPADDI_API_KEY;

// Map our internal platform names → Betpaddi bookie slugs (with country code)
const SLUG_MAP = {
  Sportybet:  'sportybet:ng',
  Bet9ja:     'bet9ja',
  BetKing:    'betking:ng',
  '1xBet':    '1xbet:ng',
  BetWay:     'betway:ng',
  NairaBet:   'nairabet',
  MSport:     'msport',
  BangBet:    'bangbet',
  AccessBet:  'accessbet',
  MerryBet:   'merrybet',
  PariPesa:   'paripesa',
  '22Bet':    '22bet',
  BetWinner:  'betwinner:ng',
  Betpawa:    'betpawa',
  Melbet:     'melbet',
};

// All Nigerian-relevant target platforms we attempt to convert to
const TARGET_SLUGS = [
  'sportybet:ng',
  'bet9ja',
  'betking:ng',
  '1xbet:ng',
  'betway:ng',
  'msport',
  'bangbet',
  'merrybet',
  'paripesa',
  '22bet',
  'betwinner:ng',
  'betpawa',
  'melbet',
  'paripulse:ng',
  'livescorebet:ng',
];

/**
 * Converts one platform code into codes for all other supported platforms.
 *
 * @param {string} sourcePlatform - Internal platform name e.g. 'Sportybet'
 * @param {string} code           - The booking code from the source platform
 * @returns {Promise<Object>}     - { platformSlug: code } for all successful conversions.
 *                                  Always includes the source platform's own code.
 */
const convertToAllPlatforms = async (sourcePlatform, code) => {
  const sourceSlug = SLUG_MAP[sourcePlatform] ?? sourcePlatform.toLowerCase();

  // Seed with the original code for the source platform
  const result = { [sourceSlug]: code };

  if (!API_KEY) {
    logger.warn('Betpaddi: BETPADDI_API_KEY not set — skipping conversions');
    return result;
  }

  const targets = TARGET_SLUGS.filter((s) => s !== sourceSlug);

  // Fire all conversions in parallel — failures logged but don't block listing creation
  const conversions = await Promise.allSettled(
    targets.map(async (target) => {
      const { data } = await axios.post(
        `${BASE_URL}/conversion/convert-code`,
        { code, bookie1: sourceSlug, bookie2: target },
        {
          headers: {
            'X-API-Key':    API_KEY,
            'Content-Type': 'application/json',
          },
          timeout: 8000,
        },
      );
      return { target, convertedCode: data.code };
    }),
  );

  for (const outcome of conversions) {
    if (outcome.status === 'fulfilled') {
      const { target, convertedCode } = outcome.value;
      if (convertedCode) result[target] = convertedCode;
    } else {
      logger.warn(`Betpaddi: conversion failed — ${outcome.reason?.message}`);
    }
  }

  logger.info(
    `Betpaddi: "${code}" (${sourceSlug}) → ${Object.keys(result).length} platform codes generated`,
  );
  return result;
};

/**
 * Fetches the list of all bookies supported by Betpaddi.
 * Useful for admin tooling or dynamic platform lists.
 */
const getSupportedBookies = async () => {
  const { data } = await axios.get(`${BASE_URL}/conversion/bookies`, {
    headers: { 'X-API-Key': API_KEY },
    timeout: 5000,
  });
  return data.data ?? {};
};

module.exports = { convertToAllPlatforms, getSupportedBookies, SLUG_MAP, TARGET_SLUGS };
