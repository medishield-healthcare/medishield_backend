const Video = require("../models/videoModel");
const videoStorage = require("../utils/videoStorage");

const allowedFields = new Set([
  "title", "description", "url", "fileName", "mimeType", "size",
]);
const fileFields = ["url", "fileName", "mimeType", "size"];
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function publicVideo(video, warning) {
  const object = typeof video.toObject === "function" ? video.toObject() : video;
  const result = {};
  for (const key of ["_id", ...allowedFields, "status", "createdAt", "updatedAt"]) {
    if (object[key] !== undefined) result[key] = object[key];
  }
  result.cleanupPending = Boolean(object.pendingCleanupUrls?.length);
  result.deletionPending = object.status === "deleting";
  if (warning) result.warning = warning;
  return result;
}

function createVideoHandlers({ Video: Model, storage }) {
  function validateBody(body, creating) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw httpError(400, "A JSON object is required.");
    }
    if (Object.keys(body).some((key) => !allowedFields.has(key))) {
      throw httpError(400, "Only title, description, url, fileName, mimeType and size can be changed.");
    }
    const data = {};
    for (const key of ["title", "description", "url", "fileName", "mimeType"]) {
      if (!has(body, key)) continue;
      if (typeof body[key] !== "string") throw httpError(400, `${key} must be a string.`);
      data[key] = key === "description" ? body[key] : body[key].trim();
    }
    if (creating && !has(data, "title")) throw httpError(400, "title is required.");
    if (has(data, "title") && (!data.title || data.title.length > 200)) {
      throw httpError(400, "title must contain between 1 and 200 characters.");
    }
    if (has(data, "description") && data.description.length > 5000) {
      throw httpError(400, "description must not exceed 5000 characters.");
    }
    if (has(data, "url") && !storage.validateVideoUrl(data.url)) {
      throw httpError(400, "url must be a file in the configured Edge Store videos bucket.");
    }
    if (has(data, "fileName") && (!data.fileName || data.fileName.length > 255)) {
      throw httpError(400, "fileName must contain between 1 and 255 characters.");
    }
    if (has(data, "mimeType") && !/^video\/[a-z0-9.+-]+$/i.test(data.mimeType)) {
      throw httpError(400, "mimeType must be a video MIME type.");
    }
    if (has(body, "size")) {
      if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > storage.maxVideoSize) {
        throw httpError(400, "size must be a positive integer no larger than 100 MB.");
      }
      data.size = body.size;
    }
    if (creating && fileFields.some((key) => !has(data, key))) {
      throw httpError(400, "url, fileName, mimeType and size are required.");
    }
    if (!creating && Object.keys(data).length === 0) throw httpError(400, "No video changes were supplied.");
    if (creating && !has(data, "description")) data.description = "";
    return data;
  }

  function validateId(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
      throw httpError(400, "Invalid video ID.");
    }
  }

  const wrap = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      const status = error.status || (error.code === 11000 ? 409 : 503);
      const message = error.status ? error.message : error.code === 11000
        ? "This video file is already saved or awaiting cleanup."
        : "The video database is temporarily unavailable. Retry the request with the same file.";
      return res.status(status).json({
        message,
        ...(req.videoDeletionPending ? { deletionPending: true } : {}),
      });
    }
  };

  async function confirmUpload(url, size) {
    let file;
    try {
      file = await storage.confirmVideoUpload(url, size);
    } catch (error) {
      if (error.statusCode === 400) throw httpError(400, "The file size does not match the uploaded video.");
      throw httpError(error.statusCode === 503 ? 503 : 502,
        error.statusCode === 503 ? "Video storage is not configured." : "Could not confirm the video upload. Retry with the same file.");
    }
    if (file.size !== size) throw httpError(400, "The file size does not match the uploaded video.");
  }

  // Removing the reservation happens only after storage confirms deletion. If
  // either step fails the persisted URL remains available for the next retry.
  async function cleanupReplacedFiles(video) {
    const remaining = [...(video.pendingCleanupUrls || [])];
    for (const url of [...remaining]) {
      try {
        await storage.deleteVideoFile(url);
        await Model.updateOne(
          { _id: video._id, url: { $ne: url } },
          { $pull: { pendingCleanupUrls: url, storageUrls: url } }
        );
        remaining.splice(remaining.indexOf(url), 1);
      } catch {
        // Saving the new video succeeded; retain the old URL for another attempt.
      }
    }
    const object = typeof video.toObject === "function" ? video.toObject() : { ...video };
    object.pendingCleanupUrls = remaining;
    return publicVideo(object, remaining.length
      ? "Video saved. Previous file cleanup is pending; save again or delete the video to retry."
      : undefined);
  }

  const sameUpload = (video, data) => video.status === "active" &&
    [...allowedFields].every((key) => (video[key] ?? "") === (data[key] ?? ""));

  return {
    createVideo: wrap(async (req, res) => {
      const data = validateBody(req.body, true);
      const existing = await Model.findOne({ storageUrls: data.url });
      if (existing) {
        if (sameUpload(existing, data)) return res.status(200).json(publicVideo(existing));
        throw httpError(409, "This file is already saved or awaiting cleanup.");
      }
      await confirmUpload(data.url, data.size);
      let video;
      try {
        video = await Model.create({ ...data, storageUrls: [data.url] });
      } catch (error) {
        if (error.code === 11000) {
          const saved = await Model.findOne({ url: data.url });
          if (saved && sameUpload(saved, data)) return res.status(200).json(publicVideo(saved));
        }
        // Do not delete a confirmed file here: a timed-out write may have
        // committed, and the client can safely retry with this same URL.
        throw error;
      }
      return res.status(201).json(publicVideo(video));
    }),

    updateVideo: wrap(async (req, res) => {
      validateId(req.params.id);
      const data = validateBody(req.body, false);
      const current = await Model.findById(req.params.id);
      if (!current) throw httpError(404, "Video not found.");
      if (current.status !== "active") throw httpError(409, "Video deletion is pending. Retry deleting this video.");
      const replacing = has(data, "url") && data.url !== current.url;
      if (replacing) {
        if (fileFields.some((key) => !has(data, key))) {
          throw httpError(400, "A replacement requires url, fileName, mimeType and size.");
        }
        const reserved = await Model.findOne({ storageUrls: data.url });
        if (reserved) {
          throw httpError(409, "This file is already saved or awaiting cleanup. Upload a new file.");
        }
        await confirmUpload(data.url, data.size);
      } else if (fileFields.some((key) => has(data, key) && data[key] !== current[key])) {
        throw httpError(400, "File details cannot be changed without uploading a replacement video.");
      }
      const changes = { $set: data, $inc: { __v: 1 } };
      if (replacing) {
        changes.$addToSet = { pendingCleanupUrls: current.url, storageUrls: data.url };
      }
      const updated = await Model.findOneAndUpdate(
        { _id: current._id, __v: current.__v, status: "active" },
        changes,
        { new: true, runValidators: true }
      );
      if (!updated) throw httpError(409, "This video changed during the request. Refresh and retry.");
      return res.json(await cleanupReplacedFiles(updated));
    }),

    deleteVideo: wrap(async (req, res) => {
      validateId(req.params.id);
      // Atomically mark the record before deleting any files. Replacements can
      // no longer commit, and a failed deletion stays visible and retryable.
      const video = await Model.findOneAndUpdate(
        { _id: req.params.id },
        { $set: { status: "deleting" }, $inc: { __v: 1 } },
        { new: true }
      );
      if (!video) throw httpError(404, "Video not found.");
      req.videoDeletionPending = true;
      for (const url of new Set([video.url, ...video.pendingCleanupUrls])) {
        try {
          await storage.deleteVideoFile(url);
        } catch (error) {
          throw httpError(error.statusCode === 503 ? 503 : 502,
            "Video deletion is pending because storage could not remove a file. Retry deleting this video.");
        }
      }
      await Model.deleteOne({ _id: video._id, status: "deleting" });
      return res.json({ message: "Video deleted.", _id: video._id });
    }),

    getVideo: wrap(async (req, res) => {
      validateId(req.params.id);
      const video = await Model.findById(req.params.id);
      if (!video) throw httpError(404, "Video not found.");
      return res.json(publicVideo(video));
    }),

    getallVideo: wrap(async (req, res) => {
      const videos = await Model.find().sort({ createdAt: -1 });
      return res.json({ data: videos.map((video) => publicVideo(video)) });
    }),
  };
}

module.exports = {
  ...createVideoHandlers({ Video, storage: videoStorage }),
  createVideoHandlers,
};
