const mongoose = require("mongoose");

const videoSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", maxlength: 5000 },
    url: { type: String, required: true },
    fileName: { type: String, required: true, maxlength: 255 },
    mimeType: { type: String, required: true, match: /^video\/[a-z0-9.+-]+$/i },
    size: { type: Number, required: true, min: 1, max: 100 * 1024 * 1024 },
    status: { type: String, enum: ["active", "deleting"], default: "active" },
    pendingCleanupUrls: { type: [String], default: [] },
    // Reserve both the current file and files awaiting cleanup. A concurrent
    // request must never attach a file that another request is deleting.
    storageUrls: { type: [String], required: true },
  },
  { timestamps: true, collection: "video" }
);

videoSchema.index({ storageUrls: 1 }, { unique: true });
videoSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Video || mongoose.model("Video", videoSchema);
