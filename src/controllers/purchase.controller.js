'use strict';

const Purchase = require('../models/Purchase');
const Listing  = require('../models/Listing');
const Wallet   = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const ApiError    = require('../utils/ApiError');
const ApiResponse = require('../utils/ApiResponse');
const asyncHandler = require('../utils/asyncHandler');
const paginate = require('../utils/paginate');
const generateReference = require('../utils/generateReference');
const { initializePayment, verifyPayment } = require('../services/paystack.service');
const { holdEscrowForPurchase }            = require('../services/escrow.service');
const { creditWallet }                     = require('../services/wallet.service');
const logger = require('../utils/logger');
const notificationService = require('../services/notification.service');
const pushService         = require('../services/pushNotification.service');

/**
 * POST /api/purchases
 * Initiates a purchase: creates a pending Purchase + Paystack checkout URL.
 * Body: { listingId, paymentMethod: 'paystack' | 'wallet' }
 */
const initiatePurchase = asyncHandler(async (req, res) => {
  const { listingId, paymentMethod = 'paystack' } = req.body;
  if (!listingId) throw new ApiError(400, 'listingId is required');

  const listing = await Listing.findById(listingId);
  if (!listing) throw new ApiError(404, 'Listing not found');
  if (listing.status !== 'active') throw new ApiError(400, 'This listing is no longer available for purchase');

  if (listing.tipster.toString() === req.user._id.toString()) {
    throw new ApiError(400, 'You cannot purchase your own listing');
  }

  const existing = await Purchase.findOne({
    buyer: req.user._id,
    listing: listingId,
    status: { $in: ['pending', 'active', 'won', 'disputed'] },
  });
  if (existing) throw new ApiError(409, 'You have already purchased this listing');

  const reference = generateReference('PUR');

  const purchase = await Purchase.create({
    buyer: req.user._id,
    listing: listingId,
    paystackReference: reference,
    amountPaid:   listing.price,
    platformFee:  listing.platformFee,
    escrowAmount: listing.escrowAmount,
    status: 'pending',
  });

  // Wallet payment: deduct immediately and activate
  if (paymentMethod === 'wallet') {
    const wallet = await Wallet.findOne({ user: req.user._id });
    if (!wallet || wallet.balance < listing.price) {
      await Purchase.findByIdAndDelete(purchase._id);
      throw new ApiError(400, 'Insufficient wallet balance');
    }

    const walletService = require('../services/wallet.service');

    await walletService.debitWallet(req.user._id.toString(), listing.price, {
      type: 'purchase',
      reference,
      description: `Unlock slip`,
      relatedListing: listingId,
      relatedPurchase: purchase._id,
    });

    await Wallet.findOneAndUpdate(
      { user: req.user._id },
      { $inc: { escrowBalance: listing.escrowAmount } }
    );

    logger.info(`Platform fee collected: ${listing.platformFee} kobo for purchase ${purchase._id}`);

    purchase.status = 'active';
    purchase.unlockedAt = new Date();
    await purchase.save();

    await Listing.findByIdAndUpdate(listingId, { $inc: { purchaseCount: 1 } });

    // Notify tipster of new purchase
    const amountNaira = (listing.price / 100).toLocaleString();
    notificationService.sendInApp(
      listing.tipster.toString(),
      'slip_purchased',
      '🛒 Someone bought your slip',
      `@${req.user.username} just purchased your slip for ₦${amountNaira}.`,
      { relatedListing: listing._id, relatedPurchase: purchase._id },
    ).catch(() => {});
    pushService.sendPush(
      listing.tipster.toString(),
      '🛒 New slip purchase',
      `@${req.user.username} just bought your slip for ₦${amountNaira}.`,
      { screen: 'SinglePost', listingId: listing._id.toString() },
    ).catch(() => {});

    return ApiResponse.success(res, {
      purchase,
      paymentMethod: 'wallet',
      message: 'Purchase activated from wallet',
    }, 'Purchase successful', 201);
  }

  // Paystack payment: return checkout URL
  const paystackData = await initializePayment(
    req.user.email,
    listing.price,
    reference,
    {
      purchaseId: purchase._id.toString(),
      listingId:  listingId,
      userId:     req.user._id.toString(),
      type:       'listing_purchase',
    }
  );

  return ApiResponse.success(res, {
    purchase,
    paymentUrl:    paystackData.authorization_url,
    paystackRef:   paystackData.reference,
    paymentMethod: 'paystack',
  }, 'Payment initialised', 201);
});

/**
 * GET /api/purchases/mine
 */
const getMyPurchases = asyncHandler(async (req, res) => {
  const page   = parseInt(req.query.page)  || 1;
  const limit  = parseInt(req.query.limit) || 20;
  const status = req.query.status;

  const filter = { buyer: req.user._id };
  if (status) filter.status = status;

  const skip = (page - 1) * limit;
  const [total, purchases] = await Promise.all([
    Purchase.countDocuments(filter),
    Purchase.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate({
        path: 'listing',
        select: '-bettingCode -trackedMatches',
        populate: { path: 'tipster', select: 'username profilePhoto isTipster isVerified metrics' },
      })
      .lean(),
  ]);

  const { limit: parsedLimit, ...pagination } = paginate(page, limit, total);

  const normalized = purchases.map((p) => ({
    ...p,
    amountPaid:   (p.amountPaid   ?? 0) / 100,
    platformFee:  (p.platformFee  ?? 0) / 100,
    escrowAmount: (p.escrowAmount ?? 0) / 100,
    listing: p.listing ? {
      ...p.listing,
      price:        (p.listing.price        ?? 0) / 100,
      platformFee:  (p.listing.platformFee  ?? 0) / 100,
      escrowAmount: (p.listing.escrowAmount ?? 0) / 100,
    } : null,
  }));

  return ApiResponse.success(res, { purchases: normalized, pagination });
});

/**
 * GET /api/purchases/:id
 */
const getPurchase = asyncHandler(async (req, res) => {
  const purchase = await Purchase.findById(req.params.id)
    .populate({
      path:   'listing',
      select: '-trackedMatches',
      populate: { path: 'tipster', select: 'username profilePhoto metrics isTipster' },
    })
    .populate('buyer', 'username profilePhoto')
    .lean();

  if (!purchase) throw new ApiError(404, 'Purchase not found');

  const isBuyer   = purchase.buyer._id.toString() === req.user._id.toString();
  const isTipster = purchase.listing?.tipster?._id?.toString() === req.user._id.toString();
  const isAdmin   = req.user.isAdmin;

  if (!isBuyer && !isTipster && !isAdmin) throw new ApiError(403, 'Access denied');

  const listingCode = await Listing.findById(purchase.listing._id).select('+bettingCode -_id').lean();

  const purchaseData = {
    ...purchase,
    amountPaid:   (purchase.amountPaid   ?? 0) / 100,
    platformFee:  (purchase.platformFee  ?? 0) / 100,
    escrowAmount: (purchase.escrowAmount ?? 0) / 100,
    listing: {
      ...purchase.listing,
      bettingCode:  listingCode?.bettingCode ?? null,
      price:        (purchase.listing.price        ?? 0) / 100,
      platformFee:  (purchase.listing.platformFee  ?? 0) / 100,
      escrowAmount: (purchase.listing.escrowAmount ?? 0) / 100,
    },
  };

  return ApiResponse.success(res, { purchase: purchaseData });
});

/**
 * POST /api/purchases/:id/verify
 * Called by the app after Paystack redirects back.
 * Body: { reference } — the Paystack trxref from the redirect URL.
 *
 * Idempotent: if the purchase is already active (webhook beat us), returns success.
 * If Paystack confirms payment, activates the purchase immediately so the user
 * doesn't have to wait for the webhook.
 */
const verifyPurchase = asyncHandler(async (req, res) => {
  const { reference } = req.body;
  if (!reference) throw new ApiError(400, 'reference is required');

  const purchase = await Purchase.findById(req.params.id).populate('listing');
  if (!purchase) throw new ApiError(404, 'Purchase not found');

  if (purchase.buyer.toString() !== req.user._id.toString()) {
    throw new ApiError(403, 'Access denied');
  }

  if (purchase.status === 'active') {
    return ApiResponse.success(res, { purchase, alreadyActive: true }, 'Already active');
  }

  if (purchase.status !== 'pending') {
    throw new ApiError(400, `Purchase cannot be verified in status: ${purchase.status}`);
  }

  // Verify payment with Paystack
  let tx;
  try {
    tx = await verifyPayment(reference);
  } catch {
    return ApiResponse.success(res, { status: 'pending' }, 'Payment is still being confirmed');
  }

  if (tx.status !== 'success') {
    return ApiResponse.success(res, { status: 'pending' }, 'Payment not yet successful');
  }

  // Amount guard: Paystack returns kobo
  if (tx.amount < purchase.amountPaid) {
    throw new ApiError(400, 'Payment amount is less than expected');
  }

  // Atomically claim the purchase — only one concurrent caller wins.
  // If the webhook already processed it (set status to 'active'), this returns null.
  const claimed = await Purchase.findOneAndUpdate(
    { _id: purchase._id, status: 'pending' },
    { $set: { status: 'processing' } },
  );
  if (!claimed) {
    const updated = await Purchase.findById(purchase._id);
    return ApiResponse.success(res, { purchase: updated, alreadyActive: true }, 'Already processed');
  }

  // Credit escrow portion to buyer's wallet then immediately lock it
  await creditWallet(req.user._id.toString(), purchase.escrowAmount, {
    type:            'deposit',
    reference:       `${reference}-ESCROW-CREDIT`,
    description:     `Purchase escrow credit for listing ${purchase.listing._id}`,
    relatedListing:  purchase.listing._id,
    relatedPurchase: purchase._id,
  });

  await holdEscrowForPurchase(purchase._id.toString());
  await Listing.findByIdAndUpdate(purchase.listing._id, { $inc: { purchaseCount: 1 } });

  // Notify tipster
  const amountNaira = (purchase.amountPaid / 100).toLocaleString();
  notificationService.sendInApp(
    purchase.listing.tipster.toString(),
    'slip_purchased',
    '🛒 Someone bought your slip',
    `A new purchase of ₦${amountNaira} was made on your slip.`,
    { relatedListing: purchase.listing._id, relatedPurchase: purchase._id },
  ).catch(() => {});
  pushService.sendPush(
    purchase.listing.tipster.toString(),
    '🛒 New slip purchase',
    `Someone just bought your slip for ₦${amountNaira}.`,
    { screen: 'SinglePost', listingId: purchase.listing._id.toString() },
  ).catch(() => {});

  const activated = await Purchase.findById(purchase._id);
  logger.info(`Purchase verified via Paystack: purchaseId=${purchase._id} ref=${reference}`);
  return ApiResponse.success(res, { purchase: activated }, 'Purchase activated');
});

module.exports = { initiatePurchase, getMyPurchases, getPurchase, verifyPurchase };
