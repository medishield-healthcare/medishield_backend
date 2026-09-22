const express = require("express");
const { authMiddleware, isAdmin } = require("../middlewares/authMiddleware");
const { getActivityLogs } = require("../controller/activityLogCtrl");
const router = express.Router();

// Audit entries can only be read by admins; there are no edit/delete endpoints.
router.get("/", authMiddleware, isAdmin, getActivityLogs);

module.exports = router;
