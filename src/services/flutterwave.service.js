/**
 * services/flutterwave.service.js — All Flutterwave v3 API interactions.
 *
 * Amount convention:
 *   Flutterwave API  → NAIRA
 *   Internal storage → KOBO
 *   Conversion at the boundary of every function (÷100 going out, ×100 coming in).
 */

'use strict';

const flwClient = require('../config/flutterwave');
const logger    = require('../utils/logger');

// ── In-memory bank list cache (banks rarely change — 1 hour TTL) ──────────────
let _bankCache     = null;
let _bankCacheTime = 0;
const BANK_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ── Payment link ──────────────────────────────────────────────────────────────

/**
 * Initialises a Flutterwave Standard checkout and returns the hosted payment link.
 * @param {string} email        Customer email
 * @param {number} amountKobo   Amount in kobo
 * @param {string} txRef        Unique reference (our generated ref)
 * @param {Object} meta         Metadata stored with the transaction
 * @param {string} redirectUrl  Deep-link / URL to redirect to after payment
 */
const initializePayment = async (email, amountKobo, txRef, meta = {}, redirectUrl) => {
  const amountNaira = amountKobo / 100;

  const { data } = await flwClient.post('/payments', {
    tx_ref:       txRef,
    amount:       amountNaira,
    currency:     'NGN',
    redirect_url: redirectUrl || `${process.env.CLIENT_URL}/payment/verify`,
    customer:     { email },
    meta,
    customizations: {
      title:       'Slipr',
      description: meta.type === 'wallet_deposit' ? 'Wallet top-up' : 'Slip purchase',
      logo:        process.env.APP_LOGO_URL || '',
    },
  });

  if (data.status !== 'success') {
    throw new Error(data.message || 'Failed to initialise payment');
  }
  return { link: data.data.link, txRef };
};

// ── Transaction verification ──────────────────────────────────────────────────

/**
 * Verifies a Flutterwave transaction by its numeric transaction ID.
 * Used by webhooks (data.id field).
 * @param {number|string} transactionId  Flutterwave transaction ID
 */
const verifyTransactionById = async (transactionId) => {
  const { data } = await flwClient.get(`/transactions/${transactionId}/verify`);
  if (data.status !== 'success') {
    throw new Error(data.message || 'Transaction verification failed');
  }
  return data.data;
};

/**
 * Finds a transaction by our own tx_ref string.
 * Used by the frontend verify call after redirect.
 * Returns null if the transaction does not exist yet.
 * @param {string} txRef  Our generated reference
 */
const verifyTransactionByRef = async (txRef) => {
  const { data } = await flwClient.get('/transactions', { params: { tx_ref: txRef } });
  if (data.status !== 'success') {
    throw new Error(data.message || 'Transaction lookup failed');
  }
  return data.data?.[0] ?? null;
};

// ── Bank list ─────────────────────────────────────────────────────────────────

/**
 * Returns the list of Nigerian banks supported by Flutterwave.
 * Result is cached in memory for 1 hour to avoid repeated API calls.
 */
const getBankList = async () => {
  const now = Date.now();
  if (_bankCache && (now - _bankCacheTime) < BANK_CACHE_TTL_MS) {
    return _bankCache;
  }

  const { data } = await flwClient.get('/banks/NG');
  if (data.status !== 'success') {
    throw new Error('Failed to fetch bank list from Flutterwave');
  }

  _bankCache     = data.data.map(({ name, code }) => ({ name, code }));
  _bankCacheTime = now;
  logger.info(`Bank list refreshed: ${_bankCache.length} banks cached`);
  return _bankCache;
};

// ── Account verification ──────────────────────────────────────────────────────

/**
 * Resolves a bank account number → account holder's name.
 * @param {string} accountNumber  10-digit NUBAN
 * @param {string} bankCode       Bank code from getBankList
 * @returns {{ account_number: string, account_name: string }}
 */
const verifyAccountNumber = async (accountNumber, bankCode) => {
  // Flutterwave test mode severely restricts /accounts/resolve (only GTBank 044 works,
  // and even that returns 502 intermittently). Skip the real call in non-production
  // so the full withdrawal flow is testable without hitting the broken sandbox endpoint.
  if (process.env.NODE_ENV !== 'production') {
    logger.warn(`FLW sandbox: skipping real account resolve for ${bankCode}/${accountNumber} — returning mock`);
    return {
      account_number: accountNumber,
      account_name:   'TEST ACCOUNT (sandbox)',
    };
  }

  const { data } = await flwClient.post('/accounts/resolve', {
    account_number: accountNumber,
    account_bank:   bankCode,
  });
  if (data.status !== 'success') {
    throw new Error(data.message || 'Could not verify account. Check the account number and bank.');
  }
  return data.data; // { account_number, account_name }
};

// ── Bank transfer (withdrawal) ────────────────────────────────────────────────

/**
 * Initiates a bank transfer to a Nigerian bank account.
 * @param {number} amountKobo     Amount in kobo (converted to naira internally)
 * @param {string} accountNumber  Destination account number
 * @param {string} bankCode       Destination bank code
 * @param {string} accountName    Account holder name (for narration)
 * @param {string} reference      Unique reference for this transfer (our withdrawal ref)
 * @param {string} narration      Bank statement narration
 * @returns {{ id: number, reference: string, status: string }}
 */
const initiateTransfer = async (
  amountKobo,
  accountNumber,
  bankCode,
  accountName,
  reference,
  narration = 'Slipr withdrawal',
) => {
  const amountNaira = amountKobo / 100;

  const { data } = await flwClient.post('/transfers', {
    account_bank:     bankCode,
    account_number:   accountNumber,
    amount:           amountNaira,
    narration,
    currency:         'NGN',
    reference,
    debit_currency:   'NGN',
    beneficiary_name: accountName,
  });

  if (data.status !== 'success') {
    throw new Error(data.message || 'Failed to initiate bank transfer');
  }

  logger.info(`FLW transfer initiated: ref=${reference} id=${data.data.id} amount=₦${amountNaira}`);
  return data.data; // { id, reference, status: 'NEW', ... }
};

module.exports = {
  initializePayment,
  verifyTransactionById,
  verifyTransactionByRef,
  getBankList,
  verifyAccountNumber,
  initiateTransfer,
};
