const express = require("express");
const multer = require("multer");
const { authMiddleware } = require("../middlewares/authMiddleware");
const { maxBlogImageSize } = require("../utils/blogStorage");
const {
  createBlog, updateBlog, deleteBlog, getBlog, getallBlog,
} = require("../controller/blogCtrl");

function createBlogAdminGuard(authenticate) {
  return (req, res, next) => {
    if (!/^Bearer \S+$/.test(req.headers.authorization || "")) {
      return res.status(401).json({ message: "Please sign in to manage blogs." });
    }
    return authenticate(req, res, (error) => {
      if (error || !req.user) return res.status(401).json({ message: "Your session expired. Please sign in again." });
      if (req.user.role !== "admin") return res.status(403).json({ message: "Only admins can manage blogs." });
      return next();
    });
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxBlogImageSize, files: 1, fields: 5, fieldSize: 200000 },
}).single("featuredImage");

function receiveBlogImage(req, res, next) {
  if (!req.is("multipart/form-data")) return next();
  return upload(req, res, (error) => {
    if (!error) return next();
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ message: status === 413
      ? "featuredImage must not exceed 5 MB."
      : "Invalid blog image upload. Use a single file field named featuredImage." });
  });
}

const router = express.Router();
const requireBlogAdmin = createBlogAdminGuard(authMiddleware);

router.get("/", getallBlog);
router.get("/:id", getBlog);
router.post("/", requireBlogAdmin, receiveBlogImage, createBlog);
router.put("/:id", requireBlogAdmin, receiveBlogImage, updateBlog);
router.delete("/:id", requireBlogAdmin, deleteBlog);

module.exports = router;
module.exports.createBlogAdminGuard = createBlogAdminGuard;
