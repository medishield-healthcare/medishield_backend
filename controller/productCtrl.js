const Product = require("../models/productModel");
const User = require("../models/userModel");
const asyncHandler = require("express-async-handler");
const validateMongoDbId = require("../utils/validateMongodbId");
const Banner = require("../models/bannerModel");
const axios = require("axios");
const { Worker } = require("worker_threads");
const dotenv = require("dotenv");
dotenv.config();
const mongoose = require("mongoose");
const { getZohoAccessToken, zohoBookApi } = require("../utils/zohoapi");
const ObjectId = mongoose.Types.ObjectId;

const createProduct = asyncHandler(async (req, res) => {
  try {
    const { sku } = req.body;
    const existingProduct = await Product.findOne({ sku: sku });
    if (existingProduct) {
      console.log(existingProduct);
      throw new Error("Product with this SKU already exists");
    }
    const newProduct = await Product.create(req.body);
    res.json(newProduct);
  } catch (error) {
    throw new Error(error);
  }
});

const updateProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  console.log(req.body);
  console.log(id);
  try {
    const updateProduct = await Product.findByIdAndUpdate(id, req.body, {
      new: true,
    });

    console.log(updateProduct);
    res.json(updateProduct);
  } catch (error) {
    throw new Error(error);
  }
});

const deleteProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  validateMongoDbId(id);
  try {
    const deleteProduct = await Product.findByIdAndDelete(id);
    res.json(deleteProduct);
  } catch (error) {
    throw new Error(error);
  }
});

const getaProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // check whether id is parsable to integer or not
  try {
    const findProduct = await Product.find({
      $and: [
        {
          $or: [
            { _id: ObjectId.isValid(id) ? ObjectId(id) : null },
            { sku: id },
            { id: !isNaN(id) ? id : 0 }, // Check if id is an integer
            { barcode: id },
          ],
        },
        { published: true },
      ],
    });

    res.json({ data: findProduct });
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const getProductById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  try {
    const findProduct = await Product.findById(id);
    if (!findProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }
    if (!findProduct.zohoProductId) {
      return res.status(200).json({
        success: true,
        findProduct,
      });
    }

    // Zoho Access Token
    const accessToken = await getZohoAccessToken();

    // Zoho se product/item fetch
    const zohoResponse = await zohoBookApi.get(
      `/items/${findProduct.zohoProductId}`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
        },
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
        },
      },
    );

    const zohoItem = zohoResponse.data.item;
    const zohoQuantity = zohoItem.available_stock;

    findProduct.max_sale_qty = zohoQuantity;
    findProduct.is_in_stock = zohoQuantity > 0;

    await findProduct.save();

    res.json({ findProduct });
  } catch (error) {
    console.log("========== ZOHO ERROR ==========");
    console.log("STATUS:", error.response?.status);
    console.log("DATA:", error.response?.data);
    console.log("URL:", error.config?.url);
    console.log("PARAMS:", error.config?.params);
    console.log("================================");

    throw new Error(error);
  }
});

const getaProductwithSku = asyncHandler(async (req, res) => {
  const { sku } = req.params;
  try {
    const findProduct = await Product.findOne({ sku: sku });
    res.json({ findProduct });
  } catch (error) {
    throw new Error(error);
  }
});

const deleteAllProduct = asyncHandler(async (req, res) => {
  try {
    const category = req.body.category;
    const deleteProduct = await Product.deleteMany({
      "categories.name": category,
    });
    res.json(deleteProduct);
  } catch (error) {
    throw new Error(error);
  }
});

const getAllBannerProducts = asyncHandler(async (req, res) => {
  try {
    const banners = await Banner.find();
    const productIds = banners.map((banner) => banner.id);

    const products = await Product.find({ sku: { $in: productIds } });
    const bannerproducts = products.map((product) => {
      const banner = banners.find((banner) => banner.id === product.id);
      return { ...product._doc, banner };
    });

    res.json({ data: banners });
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const updateBannerProduct = asyncHandler(async (req, res) => {
  const { _id, title, mobile_image, id, mobile } = req.body;
  validateMongoDbId(_id);
  const updatedBanner = await Banner.findByIdAndUpdate(
    _id,
    { title, mobile_image, id, mobile },
    { new: true, runValidators: true }
  );
  if (!updatedBanner) {
    return res.status(404).json({ message: "Banner not found" });
  }
  return res.json(updatedBanner);
});

const deleteBannerProduct = asyncHandler(async (req, res) => {
  const { id } = req.params;
  try {
    const deleteBanner = await Banner.findByIdAndDelete(id);
    res.json(deleteBanner);
  } catch (error) {
    throw new Error(error);
  }
});

const createNewBanner = asyncHandler(async (req, res) => {
  try {
    const banner = await Banner.create(req.body);
    return res.json(banner);
  } catch (error) {
    throw new Error(error);
  }
});

const contextualSearch = asyncHandler(async (req, res) => {
  try {
    const search = req.query.search;
    const pipeline = [
      {
        $search: {
          index: "products",
          text: {
            query: search,
            path: {
              wildcard: "*",
            },
          },
        },
      },

      {
        $limit: 3,
      },
      {
        $project: {
          _id: 0,
          name: 1,
          sku: 1,
          product_specs: {
            description: 1,
          },
          price: {
            minimalPrice: 1,
            regularPrice: 1,
          },
        },
      },
    ];
    const products = await Product.aggregate(pipeline);
    res.json({ data: products });
  } catch (error) {
    throw new Error(error);
  }
});

const getAllProduct = async (req, res) => {
  try {
    // Filtering
    const queryObj = { ...req.query };
    const excludeFields = [
      "page",
      "sort",
      "limit",
      "fields",
      "category",
      "featured",
      "search",
    ];
    excludeFields.forEach((el) => delete queryObj[el]);
    let queryStr = JSON.stringify(queryObj);

    queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);

    // if search is present then filter by search

    if (req.query.search && req.query.search !== "") {
      queryStr = JSON.stringify({
        ...queryObj,
        $or: [
          { name: { $regex: req.query.search, $options: "i" } },
          { manufacturer: { $regex: req.query.search, $options: "i" } },
          { short_description: { $regex: req.query.search, $options: "i" } },
          {
            barcode: req.query.search,
          },
          {
            sku: req.query.search,
          },
        ],
        published: true,
      });
    }

    // if category is present then filter by category
    if (req.query.category) {
      if (
        (req.query.category === "Endocraft" ||
          req.query.category === "Medishield Healthcare" ||
          req.query.category == "Clinician's Choice") &&
        req.query.limit == 4
      ) {
        console.log("featured category", req.query.category);
        queryStr = JSON.stringify({
          ...queryObj,
          $or: [
            { manufacturer: { $regex: req.query.category, $options: "i" } },
            {
              "categories.name": req.query.category,
            },
          ],
          published: true,
          featured: true,
        });
      } else {
        console.log("normal category", req.query.category);
        queryStr = JSON.stringify({
          ...queryObj,
          $or: [
            { manufacturer: { $regex: req.query.category, $options: "i" } },
            {
              "categories.name": req.query.category,
            },
          ],
          published: true,
        });
      }
    }
    if (req.query.featured) {
      const excludedCategories = [
        "Endocraft",
        "Medishield Healthcare",
        "Clinician's Choice",
      ];
      // find  featured products other than category - Endocraft, Medishield Healthcare, Clinician's Choice
      queryStr = JSON.stringify({
        ...queryObj,
        published: true,
        featured: true,
        $or: [
          { manufacturer: { $nin: excludedCategories } },
          {
            "categories.name": { $nin: excludedCategories },
          },
        ],
      });
    }

    let query = Product.find(JSON.parse(queryStr));

    // Sorting
    if (req.query.sort) {
      const sortBy = req.query.sort.split(",").join(" ");
      query = query.sort(sortBy);
    } else {
      query = query.sort("-createdAt");
    }

    // limiting the fields
    if (req.query.fields) {
      const fields = req.query.fields.split(",").join(" ");
      query = query.select(fields);
    } else {
      query = query.select("-__v");
    }

    let page = req.query.page;
    let limit = req.query.limit;

    // pagination
    page = req.query.page;
    limit = req.query.limit;
    let skip = (page - 1) * limit;
    query = query.skip(skip).limit(limit);
    if (req.query.page) {
      const productCount = await Product.countDocuments();
      if (skip >= productCount) throw new Error("This Page does not exists");
    }
    const product = await query;
    res.json({ data: product });
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
};

const getAllProductsAdmin = asyncHandler(async (req, res) => {
  try {
    const { page, search, brand, unpublished } = req.query;
    if (search) {
      const product = await Product.aggregate([
        {
          $facet: {
            productsWithNameStarting: [
              {
                $match: {
                  name: { $regex: `^${search}`, $options: "i" },
                },
              },
            ],
            otherProducts: [
              {
                $match: {
                  $or: [
                    { name: { $regex: search, $options: "i" } },
                    { manufacturer: { $regex: search, $options: "i" } },
                    { "categories.name": { $regex: search, $options: "i" } },
                    { barcode: search },
                    { sku: search },
                  ],
                  name: { $not: { $regex: `^${search}`, $options: "i" } }, // Exclude products with names starting with the search term
                },
              },
            ],
          },
        },
        {
          $project: {
            products: {
              $concatArrays: ["$productsWithNameStarting", "$otherProducts"],
            },
          },
        },
        { $unwind: "$products" },
        { $replaceRoot: { newRoot: "$products" } },
      ]);
      return res.json({ data: product });
    }
    if (unpublished) {
      const product = await Product.find({ published: false }).select(
        "_id name sku manufacturer published price short_description",
      );
      return res.json({ data: product });
    }
    if (brand) {
      const product = await Product.find({
        $or: [
          { manufacturer: { $regex: brand, $options: "i" } },
          {
            categories: {
              name: brand,
            },
          },
        ],
      }).select(
        "_id name sku manufacturer published price thumbnail_url media_gallery_entries short_description",
      );
      return res.json({ data: product });
    }
    const skip = (page - 1) * 52;
    const productCount = await Product.countDocuments();
    if (page || page < 1) {
      if (page > productCount) throw new Error("This Page does not exists");
    }
    const product = await Product.find({}).skip(skip).limit(52);
    res.json({ data: product, count: productCount });
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const exportAllProducts = asyncHandler(async (req, res) => {
  try {
    let worker = new Worker("./controller/workers/productExport.js", {
      workerData: process.env.MONGODB_URL,
    });
    worker.on("message", (data) => {
      const csv = Buffer.from(data, "utf-8");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=products.csv");
      res.send(csv);
    });
    worker.on("error", (error) => {
      console.log(error);
      throw new Error(error);
    });

    // dispose the worker
    worker.on("exit", (code) => {
      if (code !== 0) throw new Error(`Worker stopped with exit code ${code}`);
    });
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const addToWishlist = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  const { prodId } = req.body;
  try {
    const user = await User.findById(_id);
    const alreadyadded = user.wishlist.find((id) => id.toString() === prodId);
    if (alreadyadded) {
      let user = await User.findByIdAndUpdate(
        _id,
        {
          $pull: { wishlist: prodId },
        },
        {
          new: true,
        },
      );
      res.json(user);
    } else {
      let user = await User.findByIdAndUpdate(
        _id,
        {
          $push: { wishlist: prodId },
        },
        {
          new: true,
        },
      );
      res.json(user);
    }
  } catch (error) {
    throw new Error(error);
  }
});

const rating = asyncHandler(async (req, res) => {
  const { _id } = req.user;
  const { star, prodId, comment } = req.body;
  const name = req.user.firstname + " " + req.user.lastname;
  try {
    const product = await Product.findById(prodId);
    let alreadyRated = product.reviews.find(
      (review) => review.user.toString() === _id.toString(),
    );
    if (alreadyRated) {
      const updateRating = await Product.updateOne(
        {
          reviews: { $elemMatch: alreadyRated },
        },
        {
          $set: { "reviews.$.rating": star, "reviews.$.detail": comment },
        },
        {
          new: true,
        },
      );
    } else {
      const rateProduct = await Product.findByIdAndUpdate(
        prodId,
        {
          $push: {
            reviews: {
              user: _id,
              userName: name,
              detail: comment,
              rating: star,
            },
          },
        },
        {
          new: true,
        },
      );
    }
    const getallratings = await Product.findById(prodId);

    res.json(getallratings);
  } catch (error) {
    throw new Error("error" + error.toString());
  }
});

const bulkOperation = asyncHandler(async (req, res) => {
  const { operation, productIds, data } = req.body;
  console.log(operation, { productIds, data });
  try {
    if (operation === "delete") {
      const deleteProduct = await Product.deleteMany({
        _id: { $in: productIds },
      });
      res.json(deleteProduct);
    }
    if (operation === "publish") {
      const publishProduct = await Product.updateMany(
        {
          _id: { $in: productIds },
        },
        {
          published: true,
        },
      );
      res.json(publishProduct);
    }
    if (operation === "unpublish") {
      const unpublishProduct = await Product.updateMany(
        {
          _id: { $in: productIds },
        },
        {
          published: false,
        },
      );
      res.json(unpublishProduct);
    }
    if (operation === "import") {
      const importProduct = await Product.insertMany(data);
      res.json(importProduct);
    }
  } catch (error) {
    console.log(error);
    throw new Error(error);
  }
});

const getZohoProductPrice = (zohoProduct) => {
  let priceValue =
    zohoProduct.rate ||
    zohoProduct.unit_price ||
    zohoProduct.price ||
    zohoProduct.selling_price ||
    zohoProduct.rate_including_tax ||
    zohoProduct.price_per_unit ||
    zohoProduct.list_price ||
    zohoProduct.purchase_rate ||
    0;

  if (priceValue && typeof priceValue === "object") {
    priceValue =
      priceValue.value ||
      priceValue.total ||
      priceValue.amount ||
      priceValue.rate ||
      priceValue.price ||
      0;
  }

  const numericPrice = Number(priceValue) || 0;

  return {
    minimalPrice: numericPrice,
    maximalPrice: numericPrice,
    regularPrice: numericPrice,
  };
};

const syncZohoProducts = asyncHandler(async (req, res) => {
  try {
    const zohoOrgId = process.env.ZOHO_ORG_ID;
    if (!zohoOrgId) {
      return res.status(400).json({
        message: "Zoho organization ID is not configured",
        success: false,
      });
    }

    const accessToken = await getZohoAccessToken();
    if (!accessToken) {
      return res.status(500).json({
        message: "Unable to get Zoho access token",
        success: false,
      });
    }

    const zohoProducts = [];
    let page = 1;
    const pageLimit = 200;

    while (true) {
      const zohoResponse = await axios.get(
        "https://www.zohoapis.in/books/v3/items",
        {
          params: {
            organization_id: zohoOrgId,
            status: "active",
            page,
            per_page: pageLimit,
          },
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
          },
        },
      );

      const items = (zohoResponse.data.items || []).filter(
        (item) => item.status === "active",
      );
      zohoProducts.push(...items);

      const pageContext = zohoResponse.data.page_context || {};
      const hasMorePage = pageContext.has_more_page || pageContext.page < pageContext.total_pages || items.length === pageLimit;

      if (!hasMorePage) {
        break;
      }

      page += 1;
    }

    let addedCount = 0;
    let updatedCount = 0;
    const addedProducts = [];
    const updatedProducts = [];
    const errors = [];
    let skippedExistingSkuCount = 0;
    let skippedWithoutSkuCount = 0;
    let skippedUnchangedCount = 0;

    for (const zohoProduct of zohoProducts) {
      try {
        const zohoSku = zohoProduct.sku ? String(zohoProduct.sku).trim() : "";

        if (!zohoSku) {
          skippedWithoutSkuCount++;
          continue;
        }

        const existingProduct = await Product.findOne({ sku: zohoSku });

        const availableStock = Number(zohoProduct.available_stock) || 0;
        const productPrice = getZohoProductPrice(zohoProduct);
        const stockData = {
          is_in_stock: availableStock > 0,
          max_sale_qty: availableStock || 0,
          price: productPrice,
          zohoLastSyncedAt: new Date(),
          zoho: true,
          zohoProductId: zohoProduct.item_id,
        };

        if (existingProduct) {
          const updatedFields = [];

          if (existingProduct.is_in_stock !== stockData.is_in_stock) {
            updatedFields.push({
              field: "is_in_stock",
              previousValue: existingProduct.is_in_stock,
              newValue: stockData.is_in_stock,
            });
          }

          if (existingProduct.max_sale_qty !== stockData.max_sale_qty) {
            updatedFields.push({
              field: "max_sale_qty",
              previousValue: existingProduct.max_sale_qty,
              newValue: stockData.max_sale_qty,
            });
          }

          const existingPrice = existingProduct.price || {};
          const priceChanged =
            existingPrice.minimalPrice !== productPrice.minimalPrice;

          if (priceChanged) {
            updatedFields.push({
              field: "price.minimalPrice",
              previousValue: existingPrice.minimalPrice,
              newValue: productPrice.minimalPrice,
            });
          }

          if (updatedFields.length === 0) {
            skippedUnchangedCount++;
            continue;
          }

          const updateData = { ...stockData };
          delete updateData.price;

          const updatedProduct = await Product.findOneAndUpdate(
            { sku: zohoSku },
            {
              $set: {
                ...updateData,
                "price.minimalPrice": productPrice.minimalPrice,
              },
            },
            { new: true },
          );

          updatedCount++;
          updatedProducts.push({
            _id: updatedProduct._id,
            sku: updatedProduct.sku,
            name: updatedProduct.name,
            updatedFields,
          });
          continue;
        }

        const productWithSameSku = await Product.findOne({
          sku: zohoSku,
        });

        if (productWithSameSku) {
          skippedExistingSkuCount++;
          continue;
        }

        const dbId = new mongoose.Types.ObjectId();
        const productData = {
          _id: dbId,
          name: zohoProduct.item_name,
          sku: zohoSku,
          barcode: zohoSku,
          zoho: true,
          zohoProductId: zohoProduct.item_id,
          zohoLastSyncedAt: new Date(),
          short_description: zohoProduct.description || "",
          manufacturer: zohoProduct.manufacturer_name || "",
          is_in_stock: stockData.is_in_stock,
          max_sale_qty: stockData.max_sale_qty,
          price: getZohoProductPrice(zohoProduct),
        };

        const newProduct = await Product.create(productData);
        addedCount++;
        addedProducts.push(newProduct);
      } catch (error) {
        console.error(`Error processing Zoho product ${zohoProduct.sku}:`, error.message);
        errors.push({
          sku: zohoProduct.sku,
          error: error.message,
        });
      }
    }

    res.json({
      success: true,
      message: "Zoho products synced successfully",
      summary: {
        totalZohoProducts: zohoProducts.length,
        addedCount,
        updatedCount,
        skippedExistingSkuCount,
        skippedWithoutSkuCount,
        skippedUnchangedCount,
        errors: errors.length,
        addedProducts: addedProducts.map((p) => ({ _id: p._id, sku: p.sku, name: p.name })),
        updatedProducts,
        errors: errors.length > 0 ? errors : [],
      },
    });
  } catch (error) {
    console.error("Zoho sync error:", error.response?.data || error.message || error);
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        success: false,
        message: error.response.data.message || error.response.data,
      });
    }
    throw new Error(error);
  }
});

module.exports = {
  createProduct,
  updateBannerProduct,
  createNewBanner,
  getaProduct,
  getProductById,
  getAllProduct,
  updateProduct,
  deleteProduct,
  addToWishlist,
  rating,
  deleteAllProduct,
  getAllBannerProducts,
  getAllProductsAdmin,
  getaProductwithSku,
  contextualSearch,
  exportAllProducts,
  bulkOperation,
  deleteBannerProduct,
  syncZohoProducts,
};
