/**
 * routes/admin.routes.js — All admin API routes.
 * Mounted at /api/admin in app.js.
 * Each sub-router enforces its own role-based middleware.
 */

'use strict';

const express = require('express');
const router  = express.Router();

const { protect }             = require('../middleware/auth.middleware');
const { requireAdmin }        = require('../middleware/admin.middleware');
const { authLimiter }         = require('../middleware/rateLimit.middleware');
const { requireSuperAdmin }   = require('../middleware/superAdmin.middleware');
const { requireFinanceAdmin } = require('../middleware/financeAdmin.middleware');
const { requireSupportAdmin } = require('../middleware/supportAdmin.middleware');
const { requireEscrowAdmin }  = require('../middleware/escrowAdmin.middleware');

// ── Admin auth (no role check — just valid admin account) ─────────────────────
const { adminLogin, adminRefresh, adminLogout, adminMe } = require('../controllers/adminAuth.controller');

router.post('/auth/login',   authLimiter, adminLogin);
router.post('/auth/refresh', authLimiter, adminRefresh);
router.post('/auth/logout',  protect, requireAdmin, adminLogout);
router.get('/auth/me',       protect, requireAdmin, adminMe);

// ── Super admin routes ────────────────────────────────────────────────────────
const {
  listAdmins, createAdmin, updateAdmin, deactivateAdmin,
  getSettings, updateSettings, getAnalytics, manualRefund, manualPayout,
  recalcAnalytics, triggerAutoResolve,
} = require('../controllers/adminSuper.controller');

router.get('/super/admins',           protect, requireSuperAdmin, listAdmins);
router.post('/super/admins',          protect, requireSuperAdmin, createAdmin);
router.put('/super/admins/:id',       protect, requireSuperAdmin, updateAdmin);
router.delete('/super/admins/:id',    protect, requireSuperAdmin, deactivateAdmin);
router.get('/super/settings',         protect, requireSuperAdmin, getSettings);
router.put('/super/settings',         protect, requireSuperAdmin, updateSettings);
router.get('/super/analytics',                     protect, requireSuperAdmin, getAnalytics);
router.post('/super/analytics/recalc/:tipsterId',  protect, requireSuperAdmin, recalcAnalytics);
router.post('/super/refund',                       protect, requireSuperAdmin, manualRefund);
router.post('/super/payout',          protect, requireSuperAdmin, manualPayout);
router.post('/super/resolve-tracked', protect, requireSuperAdmin, triggerAutoResolve);

// ── Finance admin routes ──────────────────────────────────────────────────────
const {
  getTransactions, getWithdrawals, processWithdrawal,
  getRevenue, getActiveEscrow, getDeposits, issueRefund, requestLargeRefund,
} = require('../controllers/adminFinance.controller');

router.get('/finance/transactions',     protect, requireFinanceAdmin, getTransactions);
router.get('/finance/withdrawals',      protect, requireFinanceAdmin, getWithdrawals);
router.put('/finance/withdrawals/:id',  protect, requireFinanceAdmin, processWithdrawal);
router.get('/finance/revenue',          protect, requireFinanceAdmin, getRevenue);
router.get('/finance/escrow',           protect, requireFinanceAdmin, getActiveEscrow);
router.get('/finance/deposits',         protect, requireFinanceAdmin, getDeposits);
router.post('/finance/refund',          protect, requireFinanceAdmin, issueRefund);
router.post('/finance/refund/large',    protect, requireFinanceAdmin, requestLargeRefund);

// ── Support admin routes ──────────────────────────────────────────────────────
const {
  getUsers, getUserDetail, banUser, unbanUser, getUserPurchases,
  getListingDetail, openDisputeForUser, flagUser, getPendingKYC, processKYC,
} = require('../controllers/adminSupport.controller');

const { adminGetComments, adminDeleteComment } = require('../controllers/social.controller');
const { getComplaints, processComplaint } = require('../controllers/complaint.controller');

router.get('/support/users',                  protect, requireSupportAdmin, getUsers);
router.get('/support/users/:id',              protect, requireSupportAdmin, getUserDetail);
router.put('/support/users/:id/ban',          protect, requireSupportAdmin, banUser);
router.put('/support/users/:id/unban',        protect, requireSupportAdmin, unbanUser);
router.get('/support/users/:id/purchases',    protect, requireSupportAdmin, getUserPurchases);
router.get('/support/listings/:id',           protect, requireSupportAdmin, getListingDetail);
router.post('/support/disputes',              protect, requireSupportAdmin, openDisputeForUser);
router.put('/support/users/:id/flag',         protect, requireSupportAdmin, flagUser);
router.get('/support/kyc',                    protect, requireSupportAdmin, getPendingKYC);
router.put('/support/kyc/:id',                protect, requireSupportAdmin, processKYC);

// Comment moderation
router.get('/support/comments',               protect, requireSupportAdmin, adminGetComments);
router.delete('/support/comments/:id',        protect, requireSupportAdmin, adminDeleteComment);

// Complaints
router.get('/support/complaints',             protect, requireSupportAdmin, getComplaints);
router.put('/support/complaints/:id',         protect, requireSupportAdmin, processComplaint);

// ── Escrow admin routes ───────────────────────────────────────────────────────
const {
  getDisputes, getDisputeDetail, resolveDispute,
  escalateDispute, requestEvidence, getPendingOutcomes,
} = require('../controllers/adminEscrow.controller');

router.get('/escrow/disputes',                 protect, requireEscrowAdmin, getDisputes);
router.get('/escrow/disputes/:id',             protect, requireEscrowAdmin, getDisputeDetail);
router.put('/escrow/disputes/:id/resolve',     protect, requireEscrowAdmin, resolveDispute);
router.put('/escrow/disputes/:id/escalate',    protect, requireEscrowAdmin, escalateDispute);
router.put('/escrow/disputes/:id/evidence',    protect, requireEscrowAdmin, requestEvidence);
router.get('/escrow/outcomes',                 protect, requireEscrowAdmin, getPendingOutcomes);

// ── Legacy + extended admin routes (admin.controller.js) ─────────────────────
const {
  getUsers: getLegacyUsers,
  getUserById,
  banUser: legacyBanUser,
  unbanUser: legacyUnbanUser,
  unflagUser,
  updateKYCStatus,
  getDisputes: getLegacyDisputes,
  resolveDispute: legacyResolveDispute,
  markDisputeUnderReview,
  getStats,
  getListings,
  getListingById,
  forceResolveListing,
  deleteListing,
  getBoosts,
  cancelBoost,
  getVerifiedSubscriptions,
  cancelVerifiedSubscription,
  setVerified,
  getUserWallet,
  getComments,
  deleteComment,
} = require('../controllers/admin.controller');

router.get('/stats',                  protect, requireAdmin, getStats);
router.get('/users',                  protect, requireAdmin, getLegacyUsers);
router.get('/users/:id',              protect, requireAdmin, getUserById);
router.post('/users/:id/ban',         protect, requireAdmin, legacyBanUser);
router.post('/users/:id/unban',       protect, requireAdmin, legacyUnbanUser);
router.post('/users/:id/unflag',      protect, requireAdmin, unflagUser);
router.post('/users/:id/kyc',         protect, requireAdmin, updateKYCStatus);
router.put('/users/:id/verify',       protect, requireAdmin, setVerified);
router.get('/users/:id/wallet',       protect, requireAdmin, getUserWallet);
router.get('/disputes',               protect, requireAdmin, getLegacyDisputes);
router.post('/disputes/:id/review',   protect, requireAdmin, markDisputeUnderReview);
router.post('/disputes/:id/resolve',  protect, requireAdmin, legacyResolveDispute);

// Listings management
router.get('/listings',               protect, requireAdmin, getListings);
router.get('/listings/:id',           protect, requireAdmin, getListingById);
router.put('/listings/:id/outcome',   protect, requireAdmin, forceResolveListing);
router.delete('/listings/:id',        protect, requireAdmin, deleteListing);

// Boost management
router.get('/boosts',                 protect, requireAdmin, getBoosts);
router.delete('/boosts/:listingId',   protect, requireAdmin, cancelBoost);

// Verified subscription management
router.get('/subscriptions',               protect, requireAdmin, getVerifiedSubscriptions);
router.delete('/subscriptions/:userId',    protect, requireAdmin, cancelVerifiedSubscription);

// Comment moderation (top-level, not support-scoped)
router.get('/comments',               protect, requireAdmin, getComments);
router.delete('/comments/:id',        protect, requireAdmin, deleteComment);

module.exports = router;
