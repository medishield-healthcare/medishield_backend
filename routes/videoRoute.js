const express = require("express");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { createVideo, updateVideo, deleteVideo, getVideo, getallVideo } = require("../controller/videoCtrl");

function createVideoAdminGuard(authenticate) {
  return (req, res, next) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return res.status(401).json({ message: "Please sign in to manage videos." });
    }
    // The existing authentication middleware verifies the token and loads the
    // current database user. Normalize its legacy errors for this API.
    return authenticate(req, res, (error) => {
      if (error || !req.user) return res.status(401).json({ message: "Your session expired. Please sign in again." });
      if (req.user.role !== "admin") return res.status(403).json({ message: "Only admins can manage videos." });
      return next();
    });
  };
}

const router = express.Router();
const requireVideoAdmin = createVideoAdminGuard(authMiddleware);
router.get("/", getallVideo);
router.get("/:id", getVideo);
router.post("/", requireVideoAdmin, createVideo);
router.put("/:id", requireVideoAdmin, updateVideo);
router.delete("/:id", requireVideoAdmin, deleteVideo);

module.exports = router;
module.exports.createVideoAdminGuard = createVideoAdminGuard;
