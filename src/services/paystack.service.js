/**
 * services/paystack.service.js — All Paystack API interactions.
 * All amounts passed in KOBO — Paystack's native denomination.
 * Wraps the axios client from config/paystack.js.
 */

'use strict';

const paystackClient = require('../config/paystack');
const logger = require('../utils/logger');

/**
 * Initialises a Paystack payment and returns the checkout URL.
 *
 * @param {string} email - Customer email
 * @param {number} amountKobo - Amount in kobo (e.g. 110000 = ₦1,100)
 * @param {string} reference - Unique transaction reference
 * @param {Object} metadata - Additional data to store with the transaction
 * @returns {Promise<{authorization_url: string, reference: string, access_code: string}>}
 */
const initializePayment = async (email, amountKobo, reference, metadata = {}, callbackUrl) => {
  const { data } = await paystackClient.post('/transaction/initialize', {
    email,
    amount: amountKobo,
    reference,
    metadata,
    callback_url: callbackUrl || `${process.env.CLIENT_URL}/payment/verify`,
  });

  if (!data.status) throw new Error(data.message || 'Failed to initialise payment');
  return data.data; // { authorization_url, reference, access_code }
};

/**
 * Verifies a Paystack payment by reference.
 *
 * @param {string} reference - Paystack transaction reference
 * @returns {Promise<Object>} Full Paystack transaction object
 */
const verifyPayment = async (reference) => {
  const { data } = await paystackClient.get(`/transaction/verify/${reference}`);
  if (!data.status) throw new Error(data.message || 'Payment verification failed');
  return data.data;
};

/**
 * Creates a transfer recipient (Paystack requires this before a transfer).
 *
 * @param {string} bankCode - Bank code (from getBankList)
 * @param {string} accountNumber - 10-digit NUBAN
 * @param {string} name - Account holder name
 * @returns {Promise<string>} recipient_code
 */
const createTransferRecipient = async (bankCode, accountNumber, name) => {
  const { data } = await paystackClient.post('/transferrecipient', {
    type: 'nuban',
    name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN',
  });

  if (!data.status) throw new Error(data.message || 'Failed to create transfer recipient');
  return data.data.recipient_code;
};

/**
 * Initiates a transfer to a recipient.
 *
 * @param {number} amountKobo - Amount in kobo
 * @param {string} recipientCode - From createTransferRecipient
 * @param {string} reference - Unique reference for this transfer
 * @param {string} reason - Narrative visible on bank statement
 * @returns {Promise<Object>} Paystack transfer data including transfer_code
 */
const initializeTransfer = async (amountKobo, recipientCode, reference, reason = 'Slipr withdrawal') => {
  const { data } = await paystackClient.post('/transfer', {
    source: 'balance',
    amount: amountKobo,
    recipient: recipientCode,
    reference,
    reason,
  });

  if (!data.status) throw new Error(data.message || 'Failed to initialise transfer');
  return data.data; // { transfer_code, status, ... }
};

/**
 * Resolves a bank account number to the account holder's name.
 *
 * @param {string} accountNumber - 10-digit NUBAN
 * @param {string} bankCode - Bank code
 * @returns {Promise<{account_name: string, account_number: string}>}
 */
const verifyAccountNumber = async (accountNumber, bankCode) => {
  const { data } = await paystackClient.get('/bank/resolve', {
    params: { account_number: accountNumber, bank_code: bankCode },
  });

  if (!data.status) throw new Error(data.message || 'Account number verification failed');
  return data.data; // { account_name, account_number }
};

/**
 * Returns the list of Nigerian banks supported by Paystack.
 *
 * @returns {Promise<Array<{name: string, code: string}>>}
 */
const getBankList = async () => {
  const { data } = await paystackClient.get('/bank', {
    params: { country: 'nigeria', perPage: 200 },
  });

  if (!data.status) throw new Error('Failed to fetch bank list');
  return data.data.map(({ name, code }) => ({ name, code }));
};

module.exports = {
  initializePayment,
  verifyPayment,
  createTransferRecipient,
  initializeTransfer,
  verifyAccountNumber,
  getBankList,
};
