'use strict';

/**
 * One-time script to create the initial super admin account.
 * Run: node scripts/createSuperAdmin.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) { console.error('MONGODB_URI not set in .env'); process.exit(1); }

const EMAIL    = 'admin@slipr.com';
const PASSWORD = 'Faithiluvu123.';
const USERNAME = 'superadmin';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // Inline schema to avoid circular dependency issues
  const User = require('../src/models/User');

  // Check for existing super admin
  const existing = await User.findOne({ email: EMAIL });
  if (existing) {
    if (existing.isAdmin && existing.adminRole === 'super_admin') {
      console.log('Super admin already exists:', existing.email);
      await mongoose.disconnect();
      return;
    }
    // Upgrade existing account to super admin
    existing.isAdmin   = true;
    existing.adminRole = 'super_admin';
    existing.adminCreatedAt = new Date();
    await existing.save({ validateBeforeSave: false });
    console.log('Upgraded existing account to super_admin:', existing.email);
    await mongoose.disconnect();
    return;
  }

  // Create fresh super admin
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const admin = await User.create({
    email:      EMAIL,
    username:   USERNAME,
    passwordHash,
    isAdmin:    true,
    adminRole:  'super_admin',
    adminCreatedAt: new Date(),
    isEmailVerified: true,
  });

  console.log('');
  console.log('✓ Super admin created successfully');
  console.log('  Email   :', admin.email);
  console.log('  Username:', admin.username);
  console.log('  Role    :', admin.adminRole);
  console.log('  ID      :', admin._id.toString());
  console.log('');
  console.log('You can now log in at the admin panel with:');
  console.log('  Email   : admin@slipr.com');
  console.log('  Password: Faithiluvu123.');

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
