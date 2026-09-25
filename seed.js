require('dotenv').config();

const m = require('mongoose');
const b = require('bcryptjs');

const U = require('./models/User');
const P = require('./models/Product');

/* -------------------------------------------------------
   Admin configuration
------------------------------------------------------- */

const ADMIN_EMAIL =
  process.env.ADMIN_EMAIL || 'admin@tuktuk.world';

const ADMIN_MOBILE =
  process.env.ADMIN_MOBILE || '9956893895';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error(
    'ERROR: ADMIN_PASSWORD is not configured in server/.env'
  );

  process.exit(1);
}

if (ADMIN_PASSWORD.length < 8) {
  console.error(
    'ERROR: ADMIN_PASSWORD must be at least 8 characters long.'
  );

  process.exit(1);
}

/* -------------------------------------------------------
   Seed products
------------------------------------------------------- */

const data = [
  [
    'Tuktuk Backpack',
    'Durable everyday backpack.',
    1299,
    'Fashion',
    'https://images.unsplash.com/photo-1553062407-98eeb64c6a62'
  ],

  [
    'Urban Sneakers',
    'Comfortable everyday sneakers.',
    2499,
    'Fashion',
    'https://images.unsplash.com/photo-1542291026-7eec264c27ff'
  ],

  [
    'Wireless Headphones',
    'Rich wireless audio.',
    2999,
    'Electronics',
    'https://images.unsplash.com/photo-1505740420928-5e560c06d30e'
  ],

  [
    'Smart Watch',
    'Modern fitness smartwatch.',
    3499,
    'Electronics',
    'https://images.unsplash.com/photo-1523275335684-37898b6baf30'
  ]
];

/* -------------------------------------------------------
   Seed database
------------------------------------------------------- */

const seed = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error(
        'MONGO_URI is not configured in server/.env'
      );
    }

    await m.connect(process.env.MONGO_URI);

    console.log(
      'MongoDB connected for seed.'
    );

    /* ---------------------------------------------------
       Create / update admin
    --------------------------------------------------- */

    let admin = await U.findOne({
      email: ADMIN_EMAIL.toLowerCase()
    });

    const hash = await b.hash(
      ADMIN_PASSWORD,
      12
    );

    if (admin) {
      admin.name = 'Tuktuk Admin';
      admin.mobile = ADMIN_MOBILE;
      admin.password = hash;
      admin.role = 'admin';

      await admin.save();

      console.log(
        'Existing admin account updated.'
      );

    } else {
      await U.create({
        name: 'Tuktuk Admin',
        email: ADMIN_EMAIL.toLowerCase(),
        mobile: ADMIN_MOBILE,
        password: hash,
        role: 'admin'
      });

      console.log(
        'Admin account created.'
      );
    }

    /* ---------------------------------------------------
       Seed products only if none exist
    --------------------------------------------------- */

    const productCount =
      await P.countDocuments();

    if (productCount === 0) {
      await P.insertMany(
        data.map((x) => ({
          name: x[0],
          description: x[1],
          price: x[2],
          category: x[3],
          image: x[4],
          stock: 25,
          featured: true
        }))
      );

      console.log(
        'Initial products created.'
      );
    } else {
      console.log(
        'Existing products were preserved.'
      );
    }

    console.log(
      `Admin email: ${ADMIN_EMAIL}`
    );

    console.log(
      `Admin mobile: ${ADMIN_MOBILE}`
    );

    console.log(
      'Admin password: configured securely in server/.env'
    );

    console.log(
      'Seed complete.'
    );

    await m.disconnect();

    process.exit(0);

  } catch (error) {
    console.error(
      'Seed failed:',
      error.message
    );

    try {
      await m.disconnect();
    } catch {}

    process.exit(1);
  }
};

seed();