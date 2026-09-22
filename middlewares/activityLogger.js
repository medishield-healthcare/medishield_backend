const ActivityLog = require("../models/activityLogModel");

const resources = ["product", "coupon", "order", "banner", "account", "role", "brand", "category", "cart", "address", "wishlist", "review", "payment", "enquiry", "upload"];
const actionLabels = {
  create: "Created", update: "Updated", delete: "Deleted", publish: "Published",
  unpublish: "Unpublished", feature: "Featured", unfeature: "Unfeatured",
  sync: "Synchronized", import: "Imported", cancel: "Cancelled", remove: "Removed from",
  login: "Signed in to", logout: "Signed out of", password_reset: "Requested password reset for", password_change: "Changed password for",
  verify: "Verified", send_verification: "Sent verification for", export: "Exported",
};
const modules = { product: "product", coupon: "coupon", user: "account", roles: "role", brand: "brand", category: "category", cart: "cart", enquiry: "enquiry", upload: "upload" };
const sensitiveField = /password|token|secret|authorization|cookie|otp|card|cvv|paymentintent|razorpay|email|mobile|phone|address/i;
const text = (value, max = 160) => (typeof value === "string" || typeof value === "number") ? String(value).slice(0, max) : "";
const idText = value => {
  const id = value && typeof value.toHexString === "function" ? value.toHexString() : value;
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,120}$/.test(id) ? id : "";
};

function responseSummary(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const entity = body.user || body.newUser || body.deleteaUser || body.updatedBanner || body.deletedAdmin || body;
  return {
    id: idText(entity._id),
    label: text(entity.title || entity.name || entity.couponCode || entity.code || entity.sku),
    firstname: text(entity.firstname), lastname: text(entity.lastname),
    email: text(entity.email, 254), role: entity.role === "admin" ? "admin" : "user",
    failed: body.success === false,
  };
}

function describeRequest(req, moduleName, route) {
  const lower = route.toLowerCase();
  // These POST endpoints only look up existing data.
  if (lower.includes("getcouponbycode") || lower.includes("getorderbyuser") || lower.startsWith("/verify-email/")) return null;
  const specialGet = /loginwithgoogle|logout|verifyemail|sendverificationemail|export|getpendingordercsv/.test(lower);
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && !(req.method === "GET" && specialGet)) return null;

  let resource = modules[moduleName];
  if (!resource) return null;
  if (moduleName === "product" && lower.includes("banner")) resource = "banner";
  if (lower.includes("razorpay")) resource = "payment";
  else if (lower.includes("order")) resource = "order";
  else if (lower.includes("wishlist")) resource = "wishlist";
  else if (lower.includes("rating")) resource = "review";
  else if (lower.includes("address")) resource = "address";
  else if (lower.includes("cart")) resource = "cart";

  let action = req.method === "POST" ? "create" : req.method === "DELETE" ? "delete" : "update";
  const body = req.body || {};
  if (lower.includes("bulkoperation")) {
    if (!["delete", "publish", "unpublish", "import"].includes(body.operation)) return null;
    action = body.operation;
  } else if (lower.includes("login")) action = "login";
  else if (lower.includes("logout")) action = "logout";
  else if (lower.includes("forgot-password")) action = "password_reset";
  else if (lower.includes("reset-password") || lower === "/password") action = "password_change";
  else if (lower.includes("sendverification")) action = "send_verification";
  else if (/verifyemail|verify-email/.test(lower)) action = "verify";
  else if (/export|getpendingordercsv/.test(lower)) action = "export";
  else if (lower.includes("sync")) action = "sync";
  else if (lower.includes("cancel")) action = "cancel";
  else if (lower.includes("remove")) action = "remove";
  else if (lower.includes("update")) action = "update";
  else if (lower === "/save-address") action = "create";
  if (resource === "product" && Object.keys(body).length === 1) {
    if (typeof body.published === "boolean") action = body.published ? "publish" : "unpublish";
    if (typeof body.featured === "boolean") action = body.featured ? "feature" : "unfeature";
  }
  return { action, resource };
}

function buildActivityEvent(req, statusCode, response = {}, moduleName) {
  // Use the route template, never the raw URL (which can contain reset tokens).
  if (typeof req.route?.path !== "string") return null;
  const description = describeRequest(req, moduleName, req.route.path);
  if (!description) return null;
  const { action, resource } = description;
  const missingAccount = resource === "account" && ["login", "create"].includes(action) && !response.id;
  const outcome = statusCode < 400 && !response.failed && !missingAccount ? "success" : "failed";
  let user = req.user || req.activityActor;
  if (!user && outcome === "success" && response.id && resource === "account" && ["login", "create"].includes(action)) {
    user = { _id: response.id, firstname: response.firstname, lastname: response.lastname, email: response.email, role: req.route.path === "/admin-login" ? "admin" : response.role };
  }
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const actor = user ? {
    id: idText(user._id),
    name: text([user.firstname, user.lastname].filter(Boolean).join(" ")) || "Platform user",
    email: text(user.email, 254),
    role: user.role === "admin" ? "admin" : "user",
  } : { id: "", name: "Guest", email: "", role: "guest" };
  const targetIds = Array.isArray(body.productIds) ? body.productIds : [];
  // sendVerificationEmail uses a JWT in its :id parameter, not an item ID.
  const paramId = req.route.path.toLowerCase().includes("sendverification") ? undefined : req.params?.id;
  const targetId = idText(req.activityTarget?.id || paramId || body._id || body.productId || body.prodId || response.id || (resource === "account" ? user?._id : undefined));
  const labelAllowed = ["product", "coupon", "banner", "role", "brand", "category"].includes(resource);
  return {
    actor, action, resource,
    summary: `${actionLabels[action]} ${resource}`,
    target: { id: targetId, label: labelAllowed ? text(body.title || body.name || body.couponCode || body.code || body.sku || response.label) : "", ids: targetIds.slice(0, 50).map(idText).filter(Boolean) },
    changedFields: Object.keys(body).filter(key => key !== "_id" && !sensitiveField.test(key)).slice(0, 30).map(key => text(key, 80)),
    affectedCount: targetIds.length || (action === "import" && Array.isArray(body.data) ? body.data.length : undefined),
    outcome, statusCode, method: req.method,
    endpoint: `/api/${moduleName}${req.route.path}`.slice(0, 240),
    createdAt: new Date(),
  };
}

function createActivityLogger(write = event => ActivityLog.create(event)) {
  return function activityLogger(req, res, next) {
    const moduleName = req.originalUrl.split("?")[0].split("/")[2];
    if (!modules[moduleName]) return next();
    let response = {};
    const originalJson = res.json;
    res.json = function json(body) {
      response = responseSummary(body);
      return originalJson.call(this, body);
    };
    res.once("finish", () => {
      try {
        const event = buildActivityEvent(req, res.statusCode, response, moduleName);
        if (event) Promise.resolve(write(event)).catch(() => console.error("Activity log write failed"));
      } catch {
        // Audit storage must not turn a completed customer/admin action into an error.
        console.error("Activity log write failed");
      }
    });
    next();
  };
}

module.exports = { activityLogger: createActivityLogger(), createActivityLogger, buildActivityEvent, responseSummary, resources, actionLabels };
