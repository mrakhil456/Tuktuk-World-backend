const r = require('express').Router();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const auth = require('../middleware/auth');

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */

const isValidObjectId = (id) => {
  return mongoose.Types.ObjectId.isValid(id);
};

const cleanString = (value, maxLength = 500) => {
  return String(value ?? '').trim().slice(0, maxLength);
};

/*
  Escape regular-expression special characters.

  This prevents a search query from being interpreted
  as an arbitrary regular expression.
*/
const escapeRegex = (value) => {
  return String(value).replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  );
};

/*
  Only allow fields that an admin is actually allowed
  to change/create.

  This prevents unexpected fields from being injected
  through req.body.
*/
const getProductData = (body = {}) => {
  const data = {};

  if (body.name !== undefined) {
    data.name = cleanString(body.name, 200);
  }

  if (body.description !== undefined) {
    data.description = cleanString(body.description, 2000);
  }

  if (body.category !== undefined) {
    data.category = cleanString(body.category, 100);
  }

  if (body.image !== undefined) {
    data.image = cleanString(body.image, 2000);
  }

  if (body.price !== undefined) {
    const price = Number(body.price);

    if (!Number.isFinite(price) || price < 0) {
      throw new Error('Price must be a valid non-negative number.');
    }

    data.price = Number(price.toFixed(2));
  }

  if (body.stock !== undefined) {
    const stock = Number(body.stock);

    if (!Number.isInteger(stock) || stock < 0) {
      throw new Error(
        'Stock must be a non-negative whole number.'
      );
    }

    data.stock = stock;
  }

  if (body.featured !== undefined) {
    data.featured =
      body.featured === true ||
      body.featured === 'true';
  }

  return data;
};

/* -------------------------------------------------------
   GET ALL PRODUCTS
   Public
------------------------------------------------------- */

r.get('/', async (req, res) => {
  try {
    const filter = {};

    /*
      Product search.
    */
    if (req.query.q) {
      const search = cleanString(req.query.q, 100);

      if (search) {
        const re = new RegExp(
          escapeRegex(search),
          'i'
        );

        filter.$or = [
          { name: re },
          { category: re },
          { description: re }
        ];
      }
    }

    /*
      Category filter.
    */
    if (req.query.category) {
      const category = cleanString(
        req.query.category,
        100
      );

      if (category) {
        filter.category = category;
      }
    }

    const products = await Product.find(filter)
      .sort({
        featured: -1,
        createdAt: -1
      })
      .lean();

    return res.json(products);

  } catch (error) {
    console.error(
      '[PRODUCTS GET ERROR]',
      error.message
    );

    return res.status(500).json({
      message: 'Unable to load products.'
    });
  }
});

/* -------------------------------------------------------
   GET SINGLE PRODUCT
   Public
------------------------------------------------------- */

r.get('/:id', async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({
        message: 'Invalid product ID.'
      });
    }

    const product = await Product.findById(
      req.params.id
    ).lean();

    if (!product) {
      return res.status(404).json({
        message: 'Product not found.'
      });
    }

    return res.json(product);

  } catch (error) {
    console.error(
      '[PRODUCT GET ERROR]',
      error.message
    );

    return res.status(500).json({
      message: 'Unable to load product.'
    });
  }
});

/* -------------------------------------------------------
   CREATE PRODUCT
   ADMIN ONLY
------------------------------------------------------- */

r.post(
  '/',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      const data = getProductData(req.body);

      /*
        Basic required-field validation.
      */
      if (!data.name) {
        return res.status(400).json({
          message: 'Product name is required.'
        });
      }

      if (data.price === undefined) {
        return res.status(400).json({
          message: 'Product price is required.'
        });
      }

      if (data.stock === undefined) {
        data.stock = 0;
      }

      if (!data.category) {
        return res.status(400).json({
          message: 'Product category is required.'
        });
      }

      const product = await Product.create(data);

      return res.status(201).json(product);

    } catch (error) {
      console.error(
        '[PRODUCT CREATE ERROR]',
        error.message
      );

      return res.status(400).json({
        message:
          error.message ||
          'Unable to create product.'
      });
    }
  }
);

/* -------------------------------------------------------
   UPDATE PRODUCT
   ADMIN ONLY
------------------------------------------------------- */

r.put(
  '/:id',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) {
        return res.status(400).json({
          message: 'Invalid product ID.'
        });
      }

      const data = getProductData(req.body);

      if (Object.keys(data).length === 0) {
        return res.status(400).json({
          message: 'No valid product fields were provided.'
        });
      }

      const product =
        await Product.findByIdAndUpdate(
          req.params.id,
          {
            $set: data
          },
          {
            new: true,
            runValidators: true
          }
        );

      if (!product) {
        return res.status(404).json({
          message: 'Product not found.'
        });
      }

      return res.json(product);

    } catch (error) {
      console.error(
        '[PRODUCT UPDATE ERROR]',
        error.message
      );

      return res.status(400).json({
        message:
          error.message ||
          'Unable to update product.'
      });
    }
  }
);

/* -------------------------------------------------------
   DELETE PRODUCT
   ADMIN ONLY
------------------------------------------------------- */

r.delete(
  '/:id',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) {
        return res.status(400).json({
          message: 'Invalid product ID.'
        });
      }

      const product =
        await Product.findByIdAndDelete(
          req.params.id
        );

      if (!product) {
        return res.status(404).json({
          message: 'Product not found.'
        });
      }

      return res.json({
        message: 'Product deleted successfully.'
      });

    } catch (error) {
      console.error(
        '[PRODUCT DELETE ERROR]',
        error.message
      );

      return res.status(500).json({
        message: 'Unable to delete product.'
      });
    }
  }
);

module.exports = r;