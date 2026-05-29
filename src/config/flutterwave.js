/**
 * config/flutterwave.js — Axios instance pre-configured for the Flutterwave v3 API.
 * All service files import this instead of creating raw axios instances.
 */

'use strict';

const axios = require('axios');

const flwClient = axios.create({
  baseURL: 'https://api.flutterwave.com/v3',
  headers: {
    Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

flwClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const msg = error.response?.data?.message || error.message;
    return Promise.reject(new Error(`Flutterwave API error: ${msg}`));
  }
);

module.exports = flwClient;
