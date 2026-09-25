const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  try {
    const h = req.headers.authorization || '';

    if (!h.startsWith('Bearer ')) {
      return res.status(401).json({
        message: 'Login required'
      });
    }

    const token = h.slice(7).trim();

    if (!token) {
      return res.status(401).json({
        message: 'Login required'
      });
    }

    if (!process.env.JWT_SECRET) {
      console.error('JWT_SECRET is not configured');

      return res.status(500).json({
        message: 'Server configuration error'
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET,
      {
        algorithms: ['HS256']
      }
    );

    req.user = decoded;

    next();
  } catch (e) {
    return res.status(401).json({
      message: 'Invalid or expired token'
    });
  }
};

auth.admin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({
      message: 'Admin access required'
    });
  }

  next();
};

module.exports = auth;