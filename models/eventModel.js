const mongoose = require("mongoose");

const eventSchema = new mongoose.Schema(
  {
    // Public IDs can be supplied by the client (for example, "1"). MongoDB's
    // _id remains an internal database key.
    id: { type: String, required: true, unique: true, trim: true, maxlength: 120 },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    shortTitle: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, required: true, trim: true, maxlength: 100 },
    date: { type: String, required: true, trim: true, maxlength: 30 },
    month: { type: String, required: true, trim: true, maxlength: 30 },
    fullDate: { type: String, required: true, trim: true, maxlength: 100 },
    day: { type: String, required: true, trim: true, maxlength: 30 },
    time: { type: String, required: true, trim: true, maxlength: 100 },
    location: { type: String, required: true, trim: true, maxlength: 200 },
    mode: { type: String, required: true, trim: true, maxlength: 50 },
    speaker: { type: String, required: true, trim: true, maxlength: 200 },
    designation: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    eventUrl: { type: String, required: true, trim: true, maxlength: 2048 },
  },
  { timestamps: true, collection: "event", id: false }
);

eventSchema.index({ createdAt: -1 });

module.exports = mongoose.models.Event || mongoose.model("Event", eventSchema);
