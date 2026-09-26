require('dotenv').config();

const bcrypt = require('bcryptjs');
const User = require('./models/User');

const ADMIN_EMAIL =
  (process.env.ADMIN_EMAIL || 'tuktukworld261@gmail.com').toLowerCase();

const ADMIN_MOBILE =
  process.env.ADMIN_MOBILE || '9956893895';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD is not configured in server/.env');
}

if (ADMIN_PASSWORD.length < 8) {
  throw new Error('ADMIN_PASSWORD must be at least 8 characters long.');
}

const ensureAdmin = async () => {
  const existingAdmin = await User.findOne({
    email: ADMIN_EMAIL
  });

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  if (existingAdmin) {
    existingAdmin.name = 'Tuktuk Admin';
    existingAdmin.mobile = ADMIN_MOBILE;
    existingAdmin.password = passwordHash;
    existingAdmin.role = 'admin';

    await existingAdmin.save();

    console.log('Existing admin account updated.');
    return existingAdmin;
  }

  const admin = await User.create({
    name: 'Tuktuk Admin',
    email: ADMIN_EMAIL,
    mobile: ADMIN_MOBILE,
    password: passwordHash,
    role: 'admin'
  });

  console.log('Admin account created.');
  return admin;
};

module.exports = { ensureAdmin, ADMIN_EMAIL, ADMIN_MOBILE };
