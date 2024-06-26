const mongoose = require('mongoose');

const mediaEntrySchema = new mongoose.Schema({
  id: Number,
  media_type: String,
  label: String,
  file: String
}, { _id: false });

const categorySchema = new mongoose.Schema({
  name: String
}, { _id: false });

const qaSchema = new mongoose.Schema({
  question: String,
  answer: String,
  like: Number,
  dislike: Number
}, { _id: false });

const priceSchema = new mongoose.Schema({
  minimalPrice: Number,
  maximalPrice: Number,
  regularPrice: Number
}, { _id: false });

const childProductsSchema = new mongoose.Schema({
  id: Number,
  image_url: String,
  name: String,
  sku: {
    type: String,
    unique: true
  },
  special_price: Number,
  short_description: String,
  manufacturer: String,
  average_rating: String,
  max_sale_qty: Number,
  rating_count: String,
  is_in_stock: Boolean,
  pd_expiry_date: Date,
  price: {
    minimalPrice: {
      amount: {
        value: Number,
        currency: String
      }
    },
    maximalPrice: {
      amount: {
        value: Number,
        currency: String
      }
    },
    regularPrice: {
      amount: {
        value: Number,
        currency: String
      }
    }
  },
}, { _id: false });

const productSchema = new mongoose.Schema({
  id: Number,
  name: String,
  sku: {
    type: String,
    unique: true
  },
  barcode: {
    type: String,
    unique: true
  },
  inZoho: Boolean,
  thumbnail_url: String,
  short_description: String,
  medishield_coins: Number,
  manufacturer: String,
  average_rating: String,
  rating_count: String,
  is_in_stock: Boolean,
  is_cod: String,
  weight: String,
  max_sale_qty: Number,
  published: Boolean,
  pd_expiry_date: Date,
  price: priceSchema,
  media_gallery_entries: [mediaEntrySchema],
  categories: [categorySchema],
  qa_data: [qaSchema],
  product_specs: {
    description: String,
    key_specifications: String,
    packaging: String,
    direction_to_use: String,
    features: String
  },
  featured: {
    type: Boolean,
    default: false
  },
  childProducts: [childProductsSchema],
  reviews: [{
    user: {
      type: mongoose.Schema.Types.ObjectId, ref: 'User'
    },
    userName: String,
    detail: String,
    rating: Number,
  }]
});

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
