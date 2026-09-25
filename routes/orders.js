const r = require('express').Router();
const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product');
const AdminNotification = require('../models/AdminNotification');
const auth = require('../middleware/auth');

const MAX_QTY_PER_ITEM = 100;
const ALLOWED_STATUSES = [
  'PLACED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED'
];

/* -------------------------------------------------------
   Helpers
------------------------------------------------------- */

const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

const cleanQty = (qty) => {
  const n = Number(qty);

  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY_PER_ITEM) {
    return null;
  }

  return n;
};

const validateShippingAddress = (address) => {
  if (!address || typeof address !== 'object' || Array.isArray(address)) {
    return false;
  }

  try {
    return JSON.stringify(address).length <= 5000;
  } catch {
    return false;
  }
};

/*
  Builds the order items from the DATABASE.

  Important:
  We never trust:
  - item.price
  - item.name
  - item.total
  - client-calculated order total

  The database product price is authoritative.
*/
const buildOrderItems = async (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Cart is empty.');
  }

  if (items.length > 50) {
    throw new Error('Too many different products in the cart.');
  }

  const productIds = [];

  for (const item of items) {
    if (!item || !isValidObjectId(item.product)) {
      throw new Error('Invalid product in cart.');
    }

    const qty = cleanQty(item.qty);

    if (!qty) {
      throw new Error('Invalid product quantity.');
    }

    productIds.push(item.product);
  }

  const products = await Product.find({
    _id: { $in: productIds }
  }).lean();

  const productMap = new Map(
    products.map((product) => [String(product._id), product])
  );

  const orderItems = [];
  let total = 0;

  for (const item of items) {
    const product = productMap.get(String(item.product));

    if (!product) {
      throw new Error('One or more products no longer exist.');
    }

    const qty = cleanQty(item.qty);

    if (!qty) {
      throw new Error(`Invalid quantity for ${product.name}.`);
    }

    if (product.stock < qty) {
      throw new Error(
        `${product.name} has only ${product.stock} item(s) left.`
      );
    }

    const price = Number(product.price);

    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid price for ${product.name}.`);
    }

    const lineTotal = price * qty;

    total += lineTotal;

    /*
      Store a snapshot of product information.

      This means future product price/name changes
      will not change an already-created order.
    */
    orderItems.push({
      product: product._id,
      name: String(product.name || ''),
      image: String(product.image || ''),
      price,
      qty,
      lineTotal
    });
  }

  return {
    items: orderItems,
    total: Number(total.toFixed(2))
  };
};

/*
  Atomically decreases stock.

  The condition stock >= qty prevents stock
  from becoming negative because of concurrent requests.
*/
const decreaseStock = async (items) => {
  const changed = [];

  try {
    for (const item of items) {
      const qty = cleanQty(item.qty);

      const updated = await Product.findOneAndUpdate(
        {
          _id: item.product,
          stock: { $gte: qty }
        },
        {
          $inc: { stock: -qty }
        },
        {
          new: true
        }
      );

      if (!updated) {
        throw new Error(`${item.name} is no longer available in that quantity.`);
      }

      changed.push({
        product: item.product,
        qty
      });
    }

    return true;
  } catch (error) {
    /*
      Roll back any stock changes that succeeded
      before a later item failed.
    */
    for (const item of changed) {
      await Product.findByIdAndUpdate(
        item.product,
        {
          $inc: { stock: item.qty }
        }
      );
    }

    throw error;
  }
};

/* -------------------------------------------------------
   Admin notification
------------------------------------------------------- */

const createNotification = async (order, userName, kind) => {
  try {
    await AdminNotification.create({
      title:
        kind === 'COD'
          ? 'New Cash on Delivery order'
          : 'New online order',

      message:
        `${userName || 'Customer'} placed ` +
        `${kind === 'COD' ? 'a COD' : 'an online'} order ` +
        `#${order._id.toString().slice(-8)} ` +
        `for ₹${Number(order.total).toLocaleString('en-IN')}.`,

      type: 'ORDER',
      order: order._id
    });
  } catch (error) {
    /*
      Notification failure should not make a successfully
      created order look like a failed order.
    */
    console.error(
      '[ORDER NOTIFICATION ERROR]',
      error.message
    );
  }
};

/* -------------------------------------------------------
   COD ORDER
------------------------------------------------------- */

r.post('/cod', auth, async (req, res) => {
  let stockReduced = false;
  let order = null;

  try {
    const { items, shippingAddress } = req.body;

    if (!validateShippingAddress(shippingAddress)) {
      return res.status(400).json({
        message: 'A valid shipping address is required.'
      });
    }

    /*
      Calculate prices from MongoDB.
    */
    const calculated = await buildOrderItems(items);

    /*
      Reduce stock atomically before creating the order.
    */
    await decreaseStock(calculated.items);
    stockReduced = true;

    /*
      IMPORTANT:
      total comes from the server calculation,
      NOT req.body.total.
    */
    order = await Order.create({
      user: req.user.id,

      items: calculated.items,

      total: calculated.total,

      shippingAddress,

      paymentMethod: 'COD',

      paymentStatus: 'PENDING',

      status: 'PLACED'
    });

    await createNotification(
      order,
      req.user.name || 'Customer',
      'COD'
    );

    return res.status(201).json(order);

  } catch (error) {
    /*
      If stock was reduced but order creation failed,
      restore the stock.
    */
    if (stockReduced && !order) {
      try {
        const items = req.body?.items;

        if (Array.isArray(items)) {
          for (const item of items) {
            if (
              item &&
              isValidObjectId(item.product) &&
              cleanQty(item.qty)
            ) {
              await Product.findByIdAndUpdate(
                item.product,
                {
                  $inc: {
                    stock: cleanQty(item.qty)
                  }
                }
              );
            }
          }
        }
      } catch (rollbackError) {
        console.error(
          '[COD STOCK ROLLBACK ERROR]',
          rollbackError.message
        );
      }
    }

    console.error('[COD ORDER ERROR]', error.message);

    return res.status(400).json({
      message: error.message || 'Unable to place COD order.'
    });
  }
});

/* -------------------------------------------------------
   CREATE RAZORPAY ORDER
------------------------------------------------------- */

r.post('/online/create', auth, async (req, res) => {
  try {
    const { items, shippingAddress } = req.body;

    if (!validateShippingAddress(shippingAddress)) {
      return res.status(400).json({
        message: 'A valid shipping address is required.'
      });
    }

    if (
      !process.env.RAZORPAY_KEY_ID ||
      !process.env.RAZORPAY_KEY_SECRET
    ) {
      return res.status(503).json({
        message:
          'Online payment is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to server/.env.'
      });
    }

    /*
      Calculate the amount from current database prices.
    */
    const calculated = await buildOrderItems(items);

    const amount = Math.round(calculated.total * 100);

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({
        message: 'Invalid order amount.'
      });
    }

    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const receipt = `tw_${Date.now()}_${crypto
      .randomBytes(4)
      .toString('hex')}`;

    const rp = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt
    });

    /*
      Stock is NOT reduced here.

      Stock is reduced only after successful payment
      verification.
    */
    const order = await Order.create({
      user: req.user.id,

      items: calculated.items,

      total: calculated.total,

      shippingAddress,

      paymentMethod: 'ONLINE',

      paymentStatus: 'PENDING',

      status: 'PLACED',

      razorpayOrderId: rp.id
    });

    return res.status(201).json({
      orderId: order._id,

      razorpayOrderId: rp.id,

      amount: rp.amount,

      currency: rp.currency,

      keyId: process.env.RAZORPAY_KEY_ID
    });

  } catch (error) {
    console.error(
      '[RAZORPAY CREATE ERROR]',
      error.message
    );

    return res.status(400).json({
      message:
        error.message ||
        'Unable to start online payment.'
    });
  }
});

/* -------------------------------------------------------
   VERIFY RAZORPAY PAYMENT
------------------------------------------------------- */

r.post('/online/verify', auth, async (req, res) => {
  try {
    const {
      orderId,
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature
    } = req.body;

    if (!isValidObjectId(orderId)) {
      return res.status(400).json({
        message: 'Invalid order.'
      });
    }

    if (
      !razorpayOrderId ||
      !razorpayPaymentId ||
      !razorpaySignature
    ) {
      return res.status(400).json({
        message: 'Payment verification data is incomplete.'
      });
    }

    const order = await Order.findOne({
      _id: orderId,
      user: req.user.id
    });

    if (!order) {
      return res.status(404).json({
        message: 'Order not found.'
      });
    }

    if (order.paymentMethod !== 'ONLINE') {
      return res.status(400).json({
        message: 'This is not an online payment order.'
      });
    }

    /*
      Prevent duplicate verification.
    */
    if (order.paymentStatus === 'PAID') {
      return res.status(409).json({
        message: 'This payment has already been verified.',
        order
      });
    }

    /*
      IMPORTANT:
      Never trust razorpayOrderId sent by the browser.

      Compare it with the Razorpay order ID stored
      on our own database order.
    */
    if (razorpayOrderId !== order.razorpayOrderId) {
      return res.status(400).json({
        message: 'Payment order mismatch.'
      });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
      return res.status(503).json({
        message: 'Payment verification is not configured.'
      });
    }

    /*
      Razorpay signature:
      HMAC_SHA256(
        razorpay_order_id + "|" + razorpay_payment_id,
        secret
      )
    */
    const body =
      `${order.razorpayOrderId}|${razorpayPaymentId}`;

    const expected = crypto
      .createHmac(
        'sha256',
        process.env.RAZORPAY_KEY_SECRET
      )
      .update(body)
      .digest('hex');

    /*
      Timing-safe comparison.
    */
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const receivedBuffer = Buffer.from(
      String(razorpaySignature),
      'utf8'
    );

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
      )
    ) {
      return res.status(400).json({
        message: 'Payment signature verification failed.'
      });
    }

    /*
      Fetch the payment directly from Razorpay.

      This gives us an additional server-side check
      that the payment belongs to the expected order
      and amount.
    */
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const payment = await razorpay.payments.fetch(
      razorpayPaymentId
    );

    const expectedAmount =
      Math.round(Number(order.total) * 100);

    if (payment.order_id !== order.razorpayOrderId) {
      return res.status(400).json({
        message: 'Payment does not belong to this order.'
      });
    }

    if (Number(payment.amount) !== expectedAmount) {
      return res.status(400).json({
        message: 'Payment amount does not match the order.'
      });
    }

    if (payment.currency !== 'INR') {
      return res.status(400).json({
        message: 'Invalid payment currency.'
      });
    }

    /*
      A payment should be captured before the order
      is treated as paid.
    */
    if (payment.status !== 'captured') {
      return res.status(400).json({
        message:
          'Payment has not been captured yet.'
      });
    }

    /*
      Decrease stock only after payment has been
      successfully verified.
    */
    await decreaseStock(order.items);

    /*
      Save verified payment information.
    */
    order.paymentStatus = 'PAID';

    order.razorpayPaymentId =
      String(razorpayPaymentId);

    order.razorpaySignature =
      String(razorpaySignature);

    order.status = 'PLACED';

    await order.save();

    await createNotification(
      order,
      req.user.name || 'Customer',
      'ONLINE'
    );

    return res.json(order);

  } catch (error) {
    console.error(
      '[RAZORPAY VERIFY ERROR]',
      error.message
    );

    return res.status(400).json({
      message:
        error.message ||
        'Payment verification failed.'
    });
  }
});

/* -------------------------------------------------------
   GET CURRENT USER ORDERS
------------------------------------------------------- */

r.get('/my', auth, async (req, res) => {
  try {
    const orders = await Order.find({
      user: req.user.id
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json(orders);

  } catch (error) {
    console.error(
      '[MY ORDERS ERROR]',
      error.message
    );

    return res.status(500).json({
      message: 'Unable to load your orders.'
    });
  }
});

/* -------------------------------------------------------
   GET ALL ORDERS - ADMIN ONLY
------------------------------------------------------- */

r.get(
  '/',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      const orders = await Order.find()
        .populate(
          'user',
          'name email mobile'
        )
        .sort({ createdAt: -1 })
        .lean();

      return res.json(orders);

    } catch (error) {
      console.error(
        '[ADMIN ORDERS ERROR]',
        error.message
      );

      return res.status(500).json({
        message: 'Unable to load orders.'
      });
    }
  }
);

/* -------------------------------------------------------
   UPDATE ORDER STATUS - ADMIN ONLY
------------------------------------------------------- */

r.put(
  '/:id/status',
  auth,
  auth.admin,
  async (req, res) => {
    try {
      if (!isValidObjectId(req.params.id)) {
        return res.status(400).json({
          message: 'Invalid order ID.'
        });
      }

      const status = String(
        req.body.status || ''
      )
        .trim()
        .toUpperCase();

      if (!ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({
          message:
            `Invalid order status. Allowed statuses: ` +
            `${ALLOWED_STATUSES.join(', ')}.`
        });
      }

      const order =
        await Order.findByIdAndUpdate(
          req.params.id,
          { status },
          {
            new: true,
            runValidators: true
          }
        );

      if (!order) {
        return res.status(404).json({
          message: 'Order not found.'
        });
      }

      return res.json(order);

    } catch (error) {
      console.error(
        '[ORDER STATUS ERROR]',
        error.message
      );

      return res.status(500).json({
        message: 'Unable to update order status.'
      });
    }
  }
);

module.exports = r;