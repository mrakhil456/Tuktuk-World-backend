const m = require('mongoose');

const orderSchema = new m.Schema(
  {
    user: {
      type: m.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },

    items: {
      type: Array,
      required: true
    },

    total: {
      type: Number,
      required: true
    },

    shippingAddress: {
      type: Object
    },

    paymentMethod: {
      type: String,
      enum: ['COD', 'ONLINE'],
      required: true
    },

    paymentStatus: {
      type: String,
      enum: ['PENDING', 'PAID', 'FAILED'],
      default: 'PENDING'
    },

    razorpayOrderId: {
      type: String
    },

    razorpayPaymentId: {
      type: String
    },

    razorpaySignature: {
      type: String
    },

    status: {
      type: String,
      enum: [
        'PLACED',
        'PROCESSING',
        'SHIPPED',
        'DELIVERED',
        'CANCELLED'
      ],
      default: 'PLACED'
    }
  },
  {
    timestamps: true
  }
);

module.exports = m.model('Order', orderSchema);