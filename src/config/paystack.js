/**
 * config/paystack.js — Axios instance pre-configured for the Paystack API.
 * All Paystack service calls import this instead of re-creating axios.
 */

'use strict';

const axios = require('axios');

const paystackClient = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 30000,
});

// Response interceptor — log non-2xx errors for debugging
paystackClient.interceptors.response.use(
  (response) => response,
  (error) => {
    const msg = error.response?.data?.message || error.message;
    return Promise.reject(new Error(`Paystack API error: ${msg}`));
  }
);

module.exports = paystackClient;
