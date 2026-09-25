const m = require('mongoose');

const productSchema = new m.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200
    },

    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: ''
    },

    price: {
      type: Number,
      required: true,
      min: 0
    },

    category: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100
    },

    image: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: ''
    },

    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },

    featured: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

module.exports = m.model('Product', productSchema);