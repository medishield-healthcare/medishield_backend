const mongoose = require("mongoose");

const blogSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    featuredImage: { type: String, required: true },
    description: { type: String, required: true, maxlength: 200000 },
    blogMetaTitle: { type: String, default: "", trim: true, maxlength: 200 },
    blogMetaDescription: { type: String, default: "", trim: true, maxlength: 500 },
    status: { type: String, enum: ["active", "deleting"], default: "active" },
    pendingCleanupUrls: { type: [String], default: [] },
    // Keep replaced image URLs reserved until their EdgeStore files are removed.
    storageUrls: { type: [String], required: true },
  },
  { timestamps: true, collection: "blog" }
);

blogSchema.index({ storageUrls: 1 }, { unique: true });
blogSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Blog || mongoose.model("Blog", blogSchema);
