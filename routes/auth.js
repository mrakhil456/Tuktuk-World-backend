const r = require('express').Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

// ============================================================
// RESPONSE HELPERS
// ============================================================

const out = (u) => ({
  id: u._id,
  name: u.name,
  email: u.email,
  mobile: u.mobile,
  role: u.role
});

// ============================================================
// JWT
// ============================================================

const tok = (u) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign(
    {
      id: u._id,
      role: u.role,
      email: u.email,
      name: u.name
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
      algorithm: 'HS256'
    }
  );
};

// ============================================================
// OTP STORAGE
// ============================================================

const pending = new Map();

// ============================================================
// RATE LIMIT STORAGE
// ============================================================

const otpRequestByMobile = new Map();
const otpRequestByIp = new Map();
const passwordLoginByIp = new Map();

// ============================================================
// SECURITY CONSTANTS
// ============================================================

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;

const MAX_OTP_ATTEMPTS = 5;
const MAX_OTP_REQUESTS_PER_MOBILE = 5;
const MAX_OTP_REQUESTS_PER_IP = 20;
const MAX_PASSWORD_LOGIN_ATTEMPTS = 15;

const RATE_WINDOW_MS = 15 * 60 * 1000;

// ============================================================
// BASIC HELPERS
// ============================================================

const normalize = (m) =>
  String(m || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^\+91/, '');

const validMobile = (m) =>
  /^[6-9]\d{9}$/.test(m);

const validEmail = (email) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const makeOtp = () =>
  String(crypto.randomInt(100000, 1000000));

const hashOtp = (otp) =>
  crypto
    .createHash('sha256')
    .update(String(otp))
    .digest('hex');

const safeEqual = (a, b) => {
  const aBuffer = Buffer.from(String(a));
  const bBuffer = Buffer.from(String(b));

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    aBuffer,
    bBuffer
  );
};

const configured = (v) =>
  Boolean(
    v &&
      !/^your_/i.test(v) &&
      !/^change_/i.test(v)
  );

// ============================================================
// TWILIO
// ============================================================

const hasTwilio = () =>
  configured(process.env.TWILIO_ACCOUNT_SID) &&
  configured(process.env.TWILIO_AUTH_TOKEN) &&
  configured(process.env.TWILIO_VERIFY_SERVICE_SID);

const getTwilioClient = () => {
  return require('twilio')(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
};

// ============================================================
// RATE LIMIT HELPERS
// ============================================================

const getIp = (req) => {
  return String(
    req.ip ||
      req.socket?.remoteAddress ||
      'unknown'
  );
};

const cleanRateEntries = (map, now) => {
  for (const [key, timestamps] of map.entries()) {
    const valid = timestamps.filter(
      (timestamp) =>
        now - timestamp < RATE_WINDOW_MS
    );

    if (valid.length === 0) {
      map.delete(key);
    } else {
      map.set(key, valid);
    }
  }
};

const isRateLimited = (
  map,
  key,
  maxAttempts,
  windowMs = RATE_WINDOW_MS
) => {
  const now = Date.now();

  const timestamps = (
    map.get(key) || []
  ).filter(
    (timestamp) =>
      now - timestamp < windowMs
  );

  if (timestamps.length >= maxAttempts) {
    map.set(key, timestamps);
    return true;
  }

  timestamps.push(now);
  map.set(key, timestamps);

  return false;
};

const remainingCooldown = (mobile) => {
  const item = pending.get(mobile);

  if (!item || !item.createdAt) {
    return 0;
  }

  const elapsed =
    Date.now() - item.createdAt;

  if (
    elapsed >=
    OTP_RESEND_COOLDOWN_MS
  ) {
    return 0;
  }

  return (
    OTP_RESEND_COOLDOWN_MS -
    elapsed
  );
};

// ============================================================
// CLEAN EXPIRED OTP RECORDS
// ============================================================

const cleanupPending = () => {
  const now = Date.now();

  for (const [mobile, item] of pending.entries()) {
    if (
      !item ||
      item.expiresAt <= now
    ) {
      pending.delete(mobile);
    }
  }
};

// ============================================================
// SEND OTP
// ============================================================

async function sendSmsOtp(mobile, otp) {
  if (hasTwilio()) {
    const twilio = getTwilioClient();

    await twilio.verify.v2
      .services(
        process.env.TWILIO_VERIFY_SERVICE_SID
      )
      .verifications.create({
        to: `+91${mobile}`,
        channel: 'sms'
      });

    return {
      sent: true,
      devOtp: ''
    };
  }

  return {
    sent: false,
    devOtp:
      process.env.SHOW_DEV_OTP === 'true'
        ? otp
        : ''
  };
}

// ============================================================
// REQUEST OTP
// ============================================================

r.post('/request-otp', async (req, res) => {
  try {
    cleanupPending();

    const mobile = normalize(
      req.body.mobile
    );

    // IMPORTANT:
    // Keep parentheses here so an explicit
    // mode: "login" is not changed to "register".
    const mode =
      req.body.mode ||
      (
        (req.body.name || req.body.email)
          ? 'register'
          : 'login'
      );

    const ip = getIp(req);

    if (
      !['login', 'register'].includes(mode)
    ) {
      return res.status(400).json({
        message:
          'Invalid authentication mode.'
      });
    }

    if (!validMobile(mobile)) {
      return res.status(400).json({
        message:
          'Enter a valid 10-digit Indian mobile number.'
      });
    }

    if (
      isRateLimited(
        otpRequestByMobile,
        mobile,
        MAX_OTP_REQUESTS_PER_MOBILE
      )
    ) {
      return res.status(429).json({
        message:
          'Too many OTP requests. Please try again later.'
      });
    }

    if (
      isRateLimited(
        otpRequestByIp,
        ip,
        MAX_OTP_REQUESTS_PER_IP
      )
    ) {
      return res.status(429).json({
        message:
          'Too many OTP requests. Please try again later.'
      });
    }

    const cooldown =
      remainingCooldown(mobile);

    if (cooldown > 0) {
      return res.status(429).json({
        message:
          'Please wait before requesting another OTP.'
      });
    }

    const existing =
      await User.findOne({ mobile });

    // ========================================================
    // OTP LOGIN
    // ========================================================

    if (
      mode === 'login' &&
      !existing
    ) {
      return res.status(404).json({
        message:
          'No account is registered with this mobile number.'
      });
    }

    // ========================================================
    // OTP REGISTRATION
    // ========================================================

    let registrationData = null;

    if (mode === 'register') {
      const name = String(
        req.body.name || ''
      ).trim();

      const email = String(
        req.body.email || ''
      )
        .trim()
        .toLowerCase();

      const password = String(
        req.body.password || ''
      );

      if (existing) {
        return res.status(409).json({
          message:
            'This mobile number is already registered. Please login with OTP.'
        });
      }

      if (!name || !email || !password) {
        return res.status(400).json({
          message:
            'Name, email and password are required for registration.'
        });
      }

      if (name.length > 100) {
        return res.status(400).json({
          message:
            'Name is too long.'
        });
      }

      if (!validEmail(email)) {
        return res.status(400).json({
          message:
            'Enter a valid email address.'
        });
      }

      if (email.length > 254) {
        return res.status(400).json({
          message:
            'Email address is too long.'
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          message:
            'Password must be at least 6 characters.'
        });
      }

      if (password.length > 128) {
        return res.status(400).json({
          message:
            'Password is too long.'
        });
      }

      const existingEmail =
        await User.findOne({ email });

      if (existingEmail) {
        return res.status(409).json({
          message:
            'This email is already registered.'
        });
      }

      const passwordHash =
        await bcrypt.hash(password, 12);

      registrationData = {
        name,
        email,
        passwordHash
      };
    }

    // ========================================================
    // GENERATE OTP
    // ========================================================

    const otp = makeOtp();
    const otpHash = hashOtp(otp);

    pending.set(mobile, {
      otpHash,
      createdAt: Date.now(),
      expiresAt:
        Date.now() + OTP_TTL_MS,
      attempts: 0,
      mode,
      name:
        registrationData?.name || '',
      email:
        registrationData?.email || '',
      passwordHash:
        registrationData?.passwordHash || ''
    });

    // ========================================================
    // SEND OTP
    // ========================================================

    const sms =
      await sendSmsOtp(
        mobile,
        otp
      );

    return res.json({
      message: sms.sent
        ? 'OTP sent successfully.'
        : 'Development OTP generated. Configure Twilio for real SMS.',
      devOtp: sms.devOtp || ''
    });
  } catch (e) {
    console.error(
      '[AUTH REQUEST OTP ERROR]',
      e.message
    );

    return res.status(500).json({
      message:
        'Unable to send OTP. Check your SMS configuration.'
    });
  }
});

// ============================================================
// VERIFY OTP
// ============================================================

r.post('/verify-otp', async (req, res) => {
  try {
    cleanupPending();

    const mobile = normalize(
      req.body.mobile
    );

    const otp = String(
      req.body.otp || ''
    ).trim();

    if (
      !validMobile(mobile) ||
      !/^\d{6}$/.test(otp)
    ) {
      return res.status(400).json({
        message:
          'Enter a valid mobile number and 6-digit OTP.'
      });
    }

    const item =
      pending.get(mobile);

    if (!item) {
      return res.status(401).json({
        message:
          'Invalid or expired OTP.'
      });
    }

    if (
      item.expiresAt <= Date.now()
    ) {
      pending.delete(mobile);

      return res.status(401).json({
        message:
          'Invalid or expired OTP.'
      });
    }

    if (
      item.attempts >=
      MAX_OTP_ATTEMPTS
    ) {
      pending.delete(mobile);

      return res.status(429).json({
        message:
          'Too many incorrect OTP attempts. Please request a new OTP.'
      });
    }

    let verified = false;

    // ========================================================
    // TWILIO VERIFICATION
    // ========================================================

    if (hasTwilio()) {
      const twilio =
        getTwilioClient();

      const check =
        await twilio.verify.v2
          .services(
            process.env.TWILIO_VERIFY_SERVICE_SID
          )
          .verificationChecks.create({
            to: `+91${mobile}`,
            code: otp
          });

      verified =
        check.status === 'approved';
    }

    // ========================================================
    // DEVELOPMENT OTP
    // ========================================================

    else {
      const suppliedHash =
        hashOtp(otp);

      verified = safeEqual(
        suppliedHash,
        item.otpHash
      );
    }

    // ========================================================
    // INVALID OTP
    // ========================================================

    if (!verified) {
      item.attempts += 1;

      pending.set(
        mobile,
        item
      );

      if (
        item.attempts >=
        MAX_OTP_ATTEMPTS
      ) {
        pending.delete(mobile);

        return res.status(429).json({
          message:
            'Too many incorrect OTP attempts. Please request a new OTP.'
        });
      }

      return res.status(401).json({
        message:
          'Invalid or expired OTP.'
      });
    }

    // OTP is single-use.
    pending.delete(mobile);

    // ========================================================
    // FIND ACCOUNT
    // ========================================================

    let u =
      await User.findOne({ mobile });

    const mode =
      req.body.mode ||
      item.mode ||
      'login';

    // ========================================================
    // REGISTER AFTER OTP
    // ========================================================

    if (mode === 'register') {
      if (u) {
        return res.status(409).json({
          message:
            'This mobile number is already registered. Please login instead.'
        });
      }

      const name =
        String(
          item.name ||
          req.body.name ||
          ''
        ).trim();

      const email =
        String(
          item.email ||
          req.body.email ||
          ''
        )
          .trim()
          .toLowerCase();

      const passwordHash =
        item.passwordHash || '';

      if (
        !name ||
        !validEmail(email) ||
        !passwordHash
      ) {
        return res.status(400).json({
          message:
            'Registration details are missing or invalid. Please request a new OTP.'
        });
      }

      const existingEmail =
        await User.findOne({ email });

      if (existingEmail) {
        return res.status(409).json({
          message:
            'This email is already registered.'
        });
      }

      u = await User.create({
        name,
        email,
        mobile,
        password: passwordHash,
        role: 'customer'
      });
    }

    // ========================================================
    // LOGIN
    // ========================================================

    if (!u) {
      return res.status(404).json({
        message:
          'Account not found. Please register first.'
      });
    }

    return res.json({
      token: tok(u),
      user: out(u)
    });
  } catch (e) {
    console.error(
      '[AUTH VERIFY OTP ERROR]',
      e.message
    );

    return res.status(500).json({
      message:
        'OTP verification failed.'
    });
  }
});

// ============================================================
// LOGIN WITH EMAIL + PASSWORD
// ============================================================

r.post(
  '/login-password',
  async (req, res) => {
    try {
      const ip = getIp(req);

      if (
        isRateLimited(
          passwordLoginByIp,
          ip,
          MAX_PASSWORD_LOGIN_ATTEMPTS
        )
      ) {
        return res.status(429).json({
          message:
            'Too many login attempts. Please try again later.'
        });
      }

      const email = String(
        req.body.email || ''
      )
        .trim()
        .toLowerCase();

      const password = String(
        req.body.password || ''
      );

      if (!email || !password) {
        return res.status(400).json({
          message:
            'Email and password are required.'
        });
      }

      if (email.length > 254) {
        return res.status(401).json({
          message:
            'Invalid email or password.'
        });
      }

      if (password.length > 128) {
        return res.status(401).json({
          message:
            'Invalid email or password.'
        });
      }

      // IMPORTANT:
      // User.js may use select:false for password.
      // Explicitly include the password hash.
      const u =
        await User.findOne({ email })
          .select('+password');

      if (!u || !u.password) {
        return res.status(401).json({
          message:
            'Invalid email or password.'
        });
      }

      const ok =
        await bcrypt.compare(
          password,
          u.password
        );

      if (!ok) {
        return res.status(401).json({
          message:
            'Invalid email or password.'
        });
      }

      return res.json({
        token: tok(u),
        user: out(u)
      });
    } catch (e) {
      console.error(
        '[AUTH PASSWORD LOGIN ERROR]',
        e.message
      );

      return res.status(500).json({
        message:
          'Unable to login.'
      });
    }
  }
);

// ============================================================
// REGISTER WITH EMAIL + PASSWORD
// ============================================================

r.post(
  '/register-password',
  async (req, res) => {
    try {
      const name = String(
        req.body.name || ''
      ).trim();

      const email = String(
        req.body.email || ''
      )
        .trim()
        .toLowerCase();

      const mobile = normalize(
        req.body.mobile
      );

      const password = String(
        req.body.password || ''
      );

      if (!name) {
        return res.status(400).json({
          message:
            'Name is required.'
        });
      }

      if (name.length > 100) {
        return res.status(400).json({
          message:
            'Name is too long.'
        });
      }

      if (!validEmail(email)) {
        return res.status(400).json({
          message:
            'Enter a valid email address.'
        });
      }

      if (email.length > 254) {
        return res.status(400).json({
          message:
            'Email address is too long.'
        });
      }

      if (!validMobile(mobile)) {
        return res.status(400).json({
          message:
            'Enter a valid 10-digit Indian mobile number.'
        });
      }

      if (password.length < 6) {
        return res.status(400).json({
          message:
            'Password must be at least 6 characters.'
        });
      }

      if (password.length > 128) {
        return res.status(400).json({
          message:
            'Password is too long.'
        });
      }

      const existing =
        await User.findOne({
          $or: [
            { email },
            { mobile }
          ]
        });

      if (existing) {
        return res.status(409).json({
          message:
            'An account with this email or mobile number already exists.'
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const u =
        await User.create({
          name,
          email,
          mobile,
          password: passwordHash,
          role: 'customer'
        });

      return res.status(201).json({
        token: tok(u),
        user: out(u)
      });
    } catch (e) {
      console.error(
        '[AUTH PASSWORD REGISTER ERROR]',
        e.message
      );

      if (
        e &&
        e.code === 11000
      ) {
        return res.status(409).json({
          message:
            'An account with this email or mobile number already exists.'
        });
      }

      return res.status(500).json({
        message:
          'Unable to create account.'
      });
    }
  }
);

// ============================================================
// PERIODIC CLEANUP
// ============================================================

setInterval(() => {
  try {
    cleanupPending();

    const now = Date.now();

    cleanRateEntries(
      otpRequestByMobile,
      now
    );

    cleanRateEntries(
      otpRequestByIp,
      now
    );

    cleanRateEntries(
      passwordLoginByIp,
      now
    );
  } catch (e) {
    console.error(
      '[AUTH CLEANUP ERROR]',
      e.message
    );
  }
}, 10 * 60 * 1000);

// ============================================================
// EXPORT
// ============================================================

module.exports = r;