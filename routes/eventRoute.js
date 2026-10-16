const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { createEvent, updateEvent, deleteEvent, getEvent, getallEvent } = require("../controller/eventCtrl");

function createEventAdminGuard(authenticate) {
  return (req, res, next) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return res.status(401).json({ message: "Please sign in to manage events." });
    }
    return authenticate(req, res, (error) => {
      if (error || !req.user) return res.status(401).json({ message: "Your session expired. Please sign in again." });
      if (req.user.role !== "admin") return res.status(403).json({ message: "Only admins can manage events." });
      return next();
    });
  };
}

const router = express.Router();
const requireEventAdmin = createEventAdminGuard(authMiddleware);

router.get("/", getallEvent);
router.get("/:id", getEvent);
router.post("/", requireEventAdmin, createEvent);
router.put("/:id", requireEventAdmin, updateEvent);
router.delete("/:id", requireEventAdmin, deleteEvent);

module.exports = router;
module.exports.createEventAdminGuard = createEventAdminGuard;
