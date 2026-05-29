/**
 * scripts/fix-tipster-overpay.js
 *
 * One-time correction: tipsters were credited ₦1,000 (escrowAmount) on wins
 * instead of the correct ₦900 (escrowAmount - platformFee).
 * This script deducts ₦100 per won purchase from each affected tipster's wallet.
 *
 * Run: node scripts/fix-tipster-overpay.js
 */

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Load all models so populate works
  require('../src/models/User');
  require('../src/models/Listing');
  const Purchase     = require('../src/models/Purchase');
  const Wallet       = require('../src/models/Wallet');
  const Transaction  = require('../src/models/Transaction');
  const generateReference = require('../src/utils/generateReference');

  // Find all won purchases — these are the ones where tipster was over-credited
  const wonPurchases = await Purchase.find({ status: 'won' })
    .populate('listing', 'tipster')
    .lean();

  console.log(`Found ${wonPurchases.length} won purchase(s) to correct\n`);

  if (wonPurchases.length === 0) {
    console.log('Nothing to fix.');
    await mongoose.disconnect();
    return;
  }

  let fixed = 0;
  let skipped = 0;

  for (const purchase of wonPurchases) {
    const tipsterId  = purchase.listing?.tipster?.toString();
    if (!tipsterId) { console.warn(`  Purchase ${purchase._id}: no tipster found, skipping`); skipped++; continue; }

    const overchargeKobo = purchase.platformFee; // 10000 = ₦100

    // Check wallet exists and has enough balance
    const wallet = await Wallet.findOne({ user: tipsterId });
    if (!wallet) { console.warn(`  Purchase ${purchase._id}: wallet not found for tipster ${tipsterId}, skipping`); skipped++; continue; }

    if (wallet.balance < overchargeKobo) {
      console.warn(`  Purchase ${purchase._id}: tipster ${tipsterId} balance (${wallet.balance} kobo) < correction (${overchargeKobo} kobo), skipping`);
      skipped++;
      continue;
    }

    // Check if already corrected (look for a correction transaction for this purchase)
    const alreadyCorrected = await Transaction.findOne({
      user: tipsterId,
      type: 'platform_fee',
      relatedPurchase: purchase._id,
    });
    if (alreadyCorrected) {
      console.log(`  Purchase ${purchase._id}: already corrected, skipping`);
      skipped++;
      continue;
    }

    const balanceBefore = wallet.balance;
    wallet.balance      -= overchargeKobo;
    wallet.totalEarned  -= overchargeKobo;
    wallet.updatedAt     = new Date();
    await wallet.save();

    await Transaction.create({
      user:            tipsterId,
      type:            'platform_fee',
      amount:          overchargeKobo,
      balanceBefore,
      balanceAfter:    wallet.balance,
      reference:       generateReference('FIXFEE'),
      description:     `Correction: platform fee deducted (purchase ${purchase._id} was credited ₦100 too much)`,
      relatedListing:  purchase.listing._id,
      relatedPurchase: purchase._id,
      status:          'success',
    });

    console.log(`  ✓ Purchase ${purchase._id} — deducted ₦${overchargeKobo / 100} from tipster ${tipsterId} (wallet: ₦${balanceBefore / 100} → ₦${wallet.balance / 100})`);
    fixed++;
  }

  console.log(`\nDone. Fixed: ${fixed}  |  Skipped: ${skipped}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
