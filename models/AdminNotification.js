const m = require('mongoose');

const adminNotificationSchema = new m.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000
    },

    type: {
      type: String,
      enum: ['ORDER', 'SYSTEM'],
      default: 'ORDER'
    },

    order: {
      type: m.Schema.Types.ObjectId,
      ref: 'Order',
      default: null
    },

    read: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

module.exports = m.model(
  'AdminNotification',
  adminNotificationSchema
);