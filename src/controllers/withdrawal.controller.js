'use strict';

const WithdrawalRequest = require('../models/WithdrawalRequest');
const Wallet            = require('../models/Wallet');
const ApiError          = require('../utils/ApiError');
const ApiResponse       = require('../utils/ApiResponse');
const asyncHandler      = require('../utils/asyncHandler');
const paginate          = require('../utils/paginate');
const generateReference = require('../utils/generateReference');
const {
  verifyAccountNumber,
  getBankList,
  initiateTransfer,
} = require('../services/flutterwave.service');
const { debitWallet, creditWallet } = require('../services/wallet.service');
const logger = require('../utils/logger');

/**
 * GET /api/withdrawals/banks
 * Returns list of supported Nigerian banks from Flutterwave.
 * Response is cached inside flutterwave.service for 1 hour.
 */
const getBanks = asyncHandler(async (req, res) => {
  const banks = await getBankList();
  return ApiResponse.success(res, { banks });
});

/**
 * POST /api/withdrawals/verify-account
 * Resolves a bank account number to the account holder's name.
 * Body: { accountNumber, bankCode }
 */
const verifyAccount = asyncHandler(async (req, res) => {
  const { accountNumber, bankCode } = req.body;
  if (!accountNumber || !bankCode) {
    throw new ApiError(400, 'accountNumber and bankCode are required');
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    throw new ApiError(400, 'Account number must be exactly 10 digits');
  }

  const account = await verifyAccountNumber(accountNumber, bankCode);
  // account = { account_number, account_name } from Flutterwave
  return ApiResponse.success(res, { account });
});

/**
 * POST /api/withdrawals
 * Body: { amount, bankCode, accountNumber, bankName, accountName }
 * amount in naira (min ₦1,000)
 *
 * Flow:
 *   1. Validate inputs and balance
 *   2. Block concurrent pending withdrawals
 *   3. Atomically debit wallet (reserves funds — the real concurrency guard)
 *   4. Create WithdrawalRequest record
 *   5. Initiate Flutterwave transfer
 *   6. On transfer init failure → refund wallet, mark failed
 *   7. Webhook (transfer.completed) handles final success/failure state
 */
const requestWithdrawal = asyncHandler(async (req, res) => {
  const { amount, bankCode, accountNumber, bankName, accountName } = req.body;

  if (!amount || !bankCode || !accountNumber || !bankName || !accountName) {
    throw new ApiError(400, 'amount, bankCode, accountNumber, bankName and accountName are required');
  }

  const amountNaira = parseFloat(amount);
  if (!Number.isFinite(amountNaira) || amountNaira < 1000) {
    throw new ApiError(400, 'Minimum withdrawal is ₦1,000');
  }
  if (amountNaira > 5_000_000) {
    throw new ApiError(400, 'Maximum withdrawal per transaction is ₦5,000,000');
  }
  if (!/^\d{10}$/.test(accountNumber)) {
    throw new ApiError(400, 'Account number must be exactly 10 digits');
  }

  const amountKobo = Math.round(amountNaira * 100);

  // Quick balance pre-check (atomic debit below is the real guard)
  const wallet = await Wallet.findOne({ user: req.user._id });
  if (!wallet) throw new ApiError(404, 'Wallet not found');
  if (wallet.balance < amountKobo) {
    const available = (wallet.balance / 100).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' });
    throw new ApiError(400, `Insufficient balance. You have ${available} available.`);
  }

  // Block if there is already a withdrawal in flight
  const pendingExists = await WithdrawalRequest.findOne({
    tipster: req.user._id,
    status:  { $in: ['pending', 'processing'] },
  });
  if (pendingExists) {
    throw new ApiError(409, 'You already have a withdrawal in progress. Please wait for it to complete.');
  }

  const reference = generateReference('WDR');

  // Atomically debit wallet — if two requests race, only one wins
  await debitWallet(req.user._id.toString(), amountKobo, {
    type:        'withdrawal',
    reference,
    description: `Withdrawal to ${bankName} •••${accountNumber.slice(-4)}`,
  });

  // Persist the request record
  const withdrawal = await WithdrawalRequest.create({
    tipster:       req.user._id,
    amount:        amountKobo,
    bankName,
    accountNumber,
    accountName,
    bankCode,
    reference,
    status:        'pending',
  });

  // Kick off the Flutterwave transfer
  try {
    const transfer = await initiateTransfer(
      amountKobo,
      accountNumber,
      bankCode,
      accountName,
      reference,
      `Slipr earnings – ${req.user.username || req.user.email}`,
    );

    withdrawal.flwTransferId  = transfer.id;
    withdrawal.flwTransferRef = transfer.reference;
    withdrawal.status         = 'processing';
    await withdrawal.save();

    logger.info(`Withdrawal initiated: id=${withdrawal._id} flwId=${transfer.id} ref=${reference} amount=₦${amountNaira}`);
  } catch (err) {
    // Transfer initiation failed — return funds and mark failed so user is not left hanging
    withdrawal.status        = 'failed';
    withdrawal.failureReason = err.message;
    await withdrawal.save();

    await creditWallet(req.user._id.toString(), amountKobo, {
      type:        'refund',
      reference:   `${reference}-REFUND`,
      description: 'Withdrawal failed — funds returned to wallet',
    });

    logger.error(`Withdrawal transfer failed: id=${withdrawal._id}:`, err.message);
    throw new ApiError(502, `Transfer could not be initiated: ${err.message}`);
  }

  return ApiResponse.success(
    res,
    { withdrawal },
    'Withdrawal initiated. Funds will arrive in your bank account within 24 hours.',
    201,
  );
});

/**
 * GET /api/withdrawals
 * Returns the authenticated tipster's withdrawal history.
 */
const getWithdrawals = asyncHandler(async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);

  const filter = { tipster: req.user._id };
  const skip   = (page - 1) * limit;

  const [total, withdrawals] = await Promise.all([
    WithdrawalRequest.countDocuments(filter),
    WithdrawalRequest.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const totalPages = Math.ceil(total / limit);
  return ApiResponse.success(res, {
    withdrawals,
    pagination: { page, limit, total, totalPages },
  });
});

module.exports = { getBanks, verifyAccount, requestWithdrawal, getWithdrawals };
