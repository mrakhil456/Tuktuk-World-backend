const m = require('mongoose');

const userSchema = new m.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },

    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      maxlength: 254
    },

    mobile: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },

    password: {
      type: String,
      default: '',
      select: false
    },

    role: {
      type: String,
      enum: ['customer', 'admin'],
      default: 'customer'
    }
  },
  {
    timestamps: true
  }
);

module.exports = m.model('User', userSchema);