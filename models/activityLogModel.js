const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema({
  actor: {
    id: { type: String, default: "", maxlength: 120 },
    name: { type: String, default: "Guest", maxlength: 160 },
    email: { type: String, default: "", maxlength: 254 },
    role: { type: String, enum: ["admin", "user", "guest"], default: "guest" },
  },
  action: { type: String, required: true, maxlength: 40 },
  resource: { type: String, required: true, maxlength: 40 },
  summary: { type: String, required: true, maxlength: 240 },
  target: {
    id: { type: String, default: "", maxlength: 120 },
    label: { type: String, default: "", maxlength: 160 },
    ids: { type: [String], default: [] },
  },
  changedFields: { type: [String], default: [] },
  affectedCount: { type: Number, min: 0 },
  outcome: { type: String, enum: ["success", "failed"], required: true },
  statusCode: { type: Number, required: true },
  method: { type: String, required: true },
  endpoint: { type: String, required: true, maxlength: 240 },
  createdAt: { type: Date, default: Date.now, immutable: true, required: true },
}, { versionKey: false });

activityLogSchema.index({ createdAt: -1, _id: -1 });
activityLogSchema.index({ resource: 1, createdAt: -1 });
activityLogSchema.index({ "actor.id": 1, createdAt: -1 });
activityLogSchema.index({ action: 1, outcome: 1, createdAt: -1 });

module.exports = mongoose.model("ActivityLog", activityLogSchema);
