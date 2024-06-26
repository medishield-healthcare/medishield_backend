const mongoose = require("mongoose");

var couponSchema = new mongoose.Schema({
    couponCode: {
        type: String,
        required: true,
    },
    discount: {
        type: Number,
        required: true,
    },
    type: {
        type: String,
        required: true,
        enum: ["percentage", "flat"],
    },
    minimumCartValue: {
        type: Number,
        required: true,
    },
    minimumMedishieldCoins: {
        type: Number,
        required: true,
    },
    expiryDate: {
        type: Date,
        required: true,
    },
    status: {
        type: String,
        default: "active",
        enum: ["active", "expired"],
    },
});

module.exports = mongoose.model("Coupon", couponSchema);