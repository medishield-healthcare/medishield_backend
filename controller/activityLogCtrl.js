const ActivityLog = require("../models/activityLogModel");
const { resources, actionLabels } = require("../middlewares/activityLogger");

function buildActivityQuery(query) {
  const read = name => {
    if (query[name] === undefined || query[name] === "") return "";
    if (typeof query[name] !== "string") throw new Error(`Invalid ${name}`);
    return query[name];
  };
  const pageValue = read("page") || "1";
  const limitValue = read("limit") || "25";
  if (!/^\d+$/.test(pageValue) || !/^\d+$/.test(limitValue)) throw new Error("Invalid pagination");
  const page = Number(pageValue), limit = Number(limitValue);
  if (page < 1 || page > 100000 || limit < 1 || limit > 100) throw new Error("Invalid pagination");
  const filter = {};
  const resource = read("resource"), action = read("action"), outcome = read("outcome"), actorRole = read("actorRole");
  if (resource) { if (!resources.includes(resource)) throw new Error("Invalid resource"); filter.resource = resource; }
  if (action) { if (!Object.hasOwn(actionLabels, action)) throw new Error("Invalid action"); filter.action = action; }
  if (outcome) { if (!["success", "failed"].includes(outcome)) throw new Error("Invalid outcome"); filter.outcome = outcome; }
  if (actorRole) { if (!["admin", "user", "guest"].includes(actorRole)) throw new Error("Invalid actor role"); filter["actor.role"] = actorRole; }
  const from = read("from"), to = read("to");
  if (from || to) {
    filter.createdAt = {};
    for (const [value, operator] of [[from, "$gte"], [to, "$lte"]]) {
      if (!value) continue;
      if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) throw new Error("Invalid date");
      filter.createdAt[operator] = new Date(value);
    }
    if (from && to && Date.parse(from) > Date.parse(to)) throw new Error("Start date must be before end date");
  }
  const search = read("search").trim();
  if (search.length > 160) throw new Error("Search must be 160 characters or fewer");
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = ["actor.name", "actor.email", "target.id", "target.label", "summary"].map(field => ({ [field]: { $regex: escaped, $options: "i" } }));
  }
  return { page, limit, filter };
}

async function getActivityLogs(req, res) {
  let query;
  try { query = buildActivityQuery(req.query); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  try {
    const { page, limit, filter } = query;
    const [data, total] = await Promise.all([
      ActivityLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ActivityLog.countDocuments(filter),
    ]);
    res.set("Cache-Control", "no-store");
    return res.json({ data, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch {
    return res.status(500).json({ message: "Unable to load activity logs. Please try again." });
  }
}

module.exports = { getActivityLogs, buildActivityQuery };
