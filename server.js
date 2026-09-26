require('dotenv').config();

const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const { ensureAdmin } = require('./seedAdmin');

const app = express();

/* -------------------------------------------------------
   Configuration
------------------------------------------------------- */

const PORT = Number(process.env.PORT) || 5000;

const CLIENT_URL =
  process.env.CLIENT_URL || 'http://localhost:5173';

const HEALTH_CHECK_URL =
  process.env.HEALTH_CHECK_URL ||
  `http://localhost:${PORT}/api/health`;

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('ERROR: MONGO_URI is not configured.');
  process.exit(1);
}

/* -------------------------------------------------------
   Security headers
------------------------------------------------------- */

app.disable('x-powered-by');

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
);

/* -------------------------------------------------------
   CORS
------------------------------------------------------- */

const allowedOrigins = CLIENT_URL
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      /*
        Allow requests without an Origin header.

        This is useful for:
        - Postman
        - server-to-server requests
        - health checks
      */
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(
        new Error('CORS origin not allowed.')
      );
    },

    methods: [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS'
    ],

    allowedHeaders: [
      'Content-Type',
      'Authorization'
    ],

    credentials: false,

    optionsSuccessStatus: 204
  })
);

/* -------------------------------------------------------
   Request body parsing
------------------------------------------------------- */

app.use(
  express.json({
    limit: '2mb',
    strict: true
  })
);

/* -------------------------------------------------------
   Health check
------------------------------------------------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    name: 'Tuktuk World API'
  });
});

/* -------------------------------------------------------
   Health check pinger
------------------------------------------------------- */

const pingHealthEndpoint = () => {
  const url = new URL(HEALTH_CHECK_URL);

  const req = http.get(
    {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      timeout: 10000
    },
    (res) => {
      res.resume();
      if (res.statusCode >= 400) {
        console.warn(
          `[HEALTH CHECK] Status ${res.statusCode} from ${HEALTH_CHECK_URL}`
        );
      }
    }
  );

  req.on('error', (err) => {
    console.warn(
      `[HEALTH CHECK] Failed: ${err.message} (${HEALTH_CHECK_URL})`
    );
  });

  req.on('timeout', () => {
    req.destroy(new Error('Health check timeout'));
  });
};

setInterval(() => {
  pingHealthEndpoint();
}, 5 * 60 * 1000);

/* -------------------------------------------------------
   API Routes
------------------------------------------------------- */

app.use(
  '/api/auth',
  require('./routes/auth')
);

app.use(
  '/api/products',
  require('./routes/products')
);

app.use(
  '/api/orders',
  require('./routes/orders')
);

app.use(
  '/api/users',
  require('./routes/users')
);

app.use(
  '/api/notifications',
  require('./routes/notifications')
);

/* -------------------------------------------------------
   Unknown API route
------------------------------------------------------- */

app.use((req, res) => {
  res.status(404).json({
    message: 'API route not found.'
  });
});

/* -------------------------------------------------------
   Global error handler
------------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error(
    '[SERVER ERROR]',
    err.message
  );

  /*
    CORS errors
    */
  if (err.message === 'CORS origin not allowed.') {
    return res.status(403).json({
      message: 'Origin is not allowed.'
    });
  }

  /*
    Invalid JSON sent by client
    */
  if (
    err instanceof SyntaxError &&
    err.status === 400 &&
    err.type === 'entity.parse.failed'
  ) {
    return res.status(400).json({
      message: 'Invalid JSON request.'
    });
  }

  /*
    Payload too large
    */
  if (
    err.type === 'entity.too.large'
  ) {
    return res.status(413).json({
      message: 'Request payload is too large.'
    });
  }

  return res.status(500).json({
    message: 'Internal server error.'
  });
});

/* -------------------------------------------------------
   MongoDB + Server startup
------------------------------------------------------- */

const startServer = async () => {
  try {
    await mongoose.connect(MONGO_URI);

    console.log(
      'MongoDB connected successfully.'
    );

    await ensureAdmin();

    app.listen(PORT, () => {
      console.log(
        `TUKTUK WORLD API running on port ${PORT}`
      );
    });

  } catch (error) {
    console.error(
      'MongoDB connection failed:',
      error.message
    );

    process.exit(1);
  }
};

/* -------------------------------------------------------
   Graceful shutdown
------------------------------------------------------- */

const shutdown = async (signal) => {
  console.log(
    `${signal} received. Shutting down server...`
  );

  try {
    await mongoose.connection.close();

    console.log(
      'MongoDB connection closed.'
    );

    process.exit(0);

  } catch (error) {
    console.error(
      'Error during shutdown:',
      error.message
    );

    process.exit(1);
  }
};

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => shutdown('SIGTERM')
);

/* -------------------------------------------------------
   Start
------------------------------------------------------- */

startServer();