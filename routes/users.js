const r = require('express').Router();

const User = require('../models/User');
const auth = require('../middleware/auth');


// ============================================================

// ADMIN ONLY
// ============================================================

r.get('/', auth, auth.admin, async (req, res) => {
  try {
    const users = await User.find()
      .select('-password')
      .lean();

    return res.json(users);
  } catch (e) {
    console.error('[USERS GET ERROR]', e.message);

    return res.status(500).json({
      message: 'Unable to load users.'
    });
  }
});


module.exports = r;