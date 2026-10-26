const Blog = require("../models/blogModel");
const blogStorage = require("../utils/blogStorage");

const editableFields = [
  "title", "featuredImage", "description", "blogMetaTitle", "blogMetaDescription",
];
const allowedFields = new Set(editableFields);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function publicBlog(blog, warning) {
  const object = typeof blog.toObject === "function" ? blog.toObject() : blog;
  const result = {};
  for (const key of ["_id", ...editableFields, "createdAt", "updatedAt"]) {
    if (object[key] !== undefined) result[key] = object[key];
  }
  result.cleanupPending = Boolean(object.pendingCleanupUrls?.length);
  result.deletionPending = object.status === "deleting";
  if (warning) result.warning = warning;
  return result;
}

function createBlogHandlers({ Blog: Model, storage }) {
  function validateBody(body, creating, hasFile) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw httpError(400, "A form or JSON object is required.");
    }
    if (Object.keys(body).some((key) => !allowedFields.has(key))) {
      throw httpError(400, `Only ${editableFields.join(", ")} can be changed.`);
    }
    if (hasFile && has(body, "featuredImage")) {
      throw httpError(400, "Send either a featuredImage file or URL, not both.");
    }
    const data = {};
    for (const key of editableFields) {
      if (!has(body, key)) continue;
      if (typeof body[key] !== "string") throw httpError(400, `${key} must be a string.`);
      data[key] = key === "description" ? body[key] : body[key].trim();
    }
    if (creating && (!has(data, "title") || !has(data, "description") ||
        (!has(data, "featuredImage") && !hasFile))) {
      throw httpError(400, "title, description and featuredImage are required.");
    }
    if (has(data, "title") && (!data.title || data.title.length > 200)) {
      throw httpError(400, "title must contain between 1 and 200 characters.");
    }
    if (has(data, "description") && (!data.description.trim() || data.description.length > 200000)) {
      throw httpError(400, "description must contain between 1 and 200000 characters.");
    }
    for (const [key, max] of [["blogMetaTitle", 200], ["blogMetaDescription", 500]]) {
      if (has(data, key) && data[key].length > max) {
        throw httpError(400, `${key} must not exceed ${max} characters.`);
      }
    }
    if (has(data, "featuredImage") && !storage.validateBlogImageUrl(data.featuredImage)) {
      throw httpError(400, "featuredImage must be a URL in the EdgeStore blogImages bucket.");
    }
    if (!creating && Object.keys(data).length === 0 && !hasFile) {
      throw httpError(400, "No blog changes were supplied.");
    }
    if (creating) {
      if (!has(data, "blogMetaTitle")) data.blogMetaTitle = "";
      if (!has(data, "blogMetaDescription")) data.blogMetaDescription = "";
    }
    return data;
  }

  function validateId(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
      throw httpError(400, "Invalid blog ID.");
    }
  }

  const wrap = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      const status = error.status || (error.code === 11000 ? 409 : 503);
      const message = error.status ? error.message : error.code === 11000
        ? "This featured image is already used by another blog."
        : "The blog database is temporarily unavailable. Please retry.";
      return res.status(status).json({
        message,
        ...(req.blogDeletionPending ? { deletionPending: true } : {}),
      });
    }
  };

  async function saveImage(req, url) {
    let uploadedUrl;
    try {
      if (req.file) {
        uploadedUrl = await storage.uploadBlogImage(req.file);
        await storage.confirmBlogImageUrl(uploadedUrl, req.file.buffer.length);
        return uploadedUrl;
      }
      await storage.confirmBlogImageUrl(url);
      return url;
    } catch (error) {
      if (uploadedUrl) {
        try { await storage.deleteBlogImage(uploadedUrl); } catch { /* Temporary uploads expire. */ }
      }
      const status = error.statusCode === 400 ? 400 : error.statusCode === 503 ? 503 : 502;
      throw httpError(status, status === 400 ? error.message : status === 503
        ? "Blog image storage is not configured."
        : "Could not save the featured image in EdgeStore. Please retry.");
    }
  }

  // Only discard an image uploaded during this request when MongoDB confirms
  // that no blog owns it. If a write result is uncertain, keep the image.
  async function discardUnusedUpload(url) {
    try {
      const owner = await Model.findOne({ storageUrls: url });
      if (!owner) await storage.deleteBlogImage(url);
    } catch {
      // An uncertain write must never cause deletion of a potentially used image.
    }
  }

  async function cleanupReplacedImages(blog) {
    const remaining = [...(blog.pendingCleanupUrls || [])];
    for (const url of [...remaining]) {
      try {
        await storage.deleteBlogImage(url);
        await Model.updateOne(
          { _id: blog._id, featuredImage: { $ne: url } },
          { $pull: { pendingCleanupUrls: url, storageUrls: url } }
        );
        remaining.splice(remaining.indexOf(url), 1);
      } catch {
        // A later update or delete can retry cleanup of this reserved URL.
      }
    }
    const object = typeof blog.toObject === "function" ? blog.toObject() : { ...blog };
    object.pendingCleanupUrls = remaining;
    return publicBlog(object, remaining.length
      ? "Blog saved, but cleanup of a previous image is pending."
      : undefined);
  }

  const sameCreate = (blog, data) => blog.status === "active" &&
    editableFields.every((key) => (blog[key] ?? "") === (data[key] ?? ""));

  return {
    createBlog: wrap(async (req, res) => {
      const data = validateBody(req.body, true, Boolean(req.file));
      let uploadedUrl;
      try {
        if (data.featuredImage) {
          const existing = await Model.findOne({ storageUrls: data.featuredImage });
          if (existing) {
            if (sameCreate(existing, data)) return res.json(publicBlog(existing));
            throw httpError(409, "This featured image is already used by another blog.");
          }
        }
        const url = await saveImage(req, data.featuredImage);
        if (req.file) uploadedUrl = url;
        data.featuredImage = url;
        let blog;
        try {
          blog = await Model.create({ ...data, storageUrls: [url] });
        } catch (error) {
          if (error.code === 11000) {
            const existing = await Model.findOne({ featuredImage: url });
            if (existing && sameCreate(existing, data)) return res.json(publicBlog(existing));
          }
          throw error;
        }
        return res.status(201).json(publicBlog(blog));
      } catch (error) {
        if (uploadedUrl) await discardUnusedUpload(uploadedUrl);
        throw error;
      }
    }),

    updateBlog: wrap(async (req, res) => {
      validateId(req.params.id);
      const data = validateBody(req.body, false, Boolean(req.file));
      const current = await Model.findById(req.params.id);
      if (!current) throw httpError(404, "Blog not found.");
      if (current.status !== "active") throw httpError(409, "Blog deletion is pending. Retry deleting this blog.");
      const replacing = Boolean(req.file) || (has(data, "featuredImage") && data.featuredImage !== current.featuredImage);
      let uploadedUrl;
      try {
        if (replacing) {
          if (data.featuredImage) {
            const owner = await Model.findOne({ storageUrls: data.featuredImage });
            if (owner) throw httpError(409, "This featured image is already used by another blog.");
          }
          const url = await saveImage(req, data.featuredImage);
          if (req.file) uploadedUrl = url;
          data.featuredImage = url;
        }
        const changes = { $set: data, $inc: { __v: 1 } };
        if (replacing) {
          changes.$addToSet = {
            pendingCleanupUrls: current.featuredImage,
            storageUrls: data.featuredImage,
          };
        }
        const updated = await Model.findOneAndUpdate(
          { _id: current._id, __v: current.__v, status: "active" },
          changes,
          { new: true, runValidators: true }
        );
        if (!updated) throw httpError(409, "This blog changed during the request. Refresh and retry.");
        return res.json(await cleanupReplacedImages(updated));
      } catch (error) {
        if (uploadedUrl) await discardUnusedUpload(uploadedUrl);
        throw error;
      }
    }),

    deleteBlog: wrap(async (req, res) => {
      validateId(req.params.id);
      const blog = await Model.findOneAndUpdate(
        { _id: req.params.id },
        { $set: { status: "deleting" }, $inc: { __v: 1 } },
        { new: true }
      );
      if (!blog) throw httpError(404, "Blog not found.");
      req.blogDeletionPending = true;
      for (const url of new Set([blog.featuredImage, ...blog.pendingCleanupUrls])) {
        try {
          await storage.deleteBlogImage(url);
        } catch (error) {
          throw httpError(error.statusCode === 503 ? 503 : 502,
            "Blog deletion is pending because EdgeStore could not remove an image. Retry deleting this blog.");
        }
      }
      await Model.deleteOne({ _id: blog._id, status: "deleting" });
      return res.json({ message: "Blog deleted.", _id: blog._id });
    }),

    getBlog: wrap(async (req, res) => {
      validateId(req.params.id);
      const blog = await Model.findById(req.params.id);
      if (!blog) throw httpError(404, "Blog not found.");
      return res.json(publicBlog(blog));
    }),

    getallBlog: wrap(async (req, res) => {
      const blogs = await Model.find().sort({ createdAt: -1 });
      return res.json({ data: blogs.map((blog) => publicBlog(blog)) });
    }),
  };
}

module.exports = {
  ...createBlogHandlers({ Blog, storage: blogStorage }),
  createBlogHandlers,
};
