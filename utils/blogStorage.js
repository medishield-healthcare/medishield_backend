const sharp = require("sharp");
const { initEdgeStore } = require("@edgestore/server");
const { initEdgeStoreClient } = require("@edgestore/server/core");

const maxBlogImageSize = 5 * 1024 * 1024;
const uuidPattern = "[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}";
const blogImagePathPattern = new RegExp(
  // The backend bucket has no .path(...) resolver, so EdgeStore normally puts
  // the generated filename directly below _public. Accept older nested URLs too.
  `^/[\\w-]+/blogImages/_public/(?:(${uuidPattern})/)?[\\w.-]+\\.(?:jpe?g|png|webp|gif)$`, "i"
);

function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

function parseBlogImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const match = blogImagePathPattern.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "files.edgestore.dev" ||
        url.port || url.username || url.password || url.search || url.hash ||
        url.href !== value || !match) return null;
    return { uploadId: match[1] };
  } catch {
    return null;
  }
}

function validateBlogImageUrl(url) {
  return parseBlogImageUrl(url) !== null;
}

function imageFormat(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { mimeType: "image/png", extension: "png" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return { mimeType: "image/gif", extension: "gif" };
  }
  return null;
}

let client;
function getClient() {
  if (!process.env.EDGE_STORE_ACCESS_KEY || !process.env.EDGE_STORE_SECRET_KEY) {
    throw Object.assign(new Error("Blog image storage is not configured."), { statusCode: 503 });
  }
  if (!client) {
    const es = initEdgeStore.create();
    client = initEdgeStoreClient({
      router: es.router({
        blogImages: es.imageBucket({ maxSize: maxBlogImageSize, accept: ["image/jpeg", "image/png", "image/webp", "image/gif"] }),
      }),
    }).blogImages;
  }
  return client;
}

function createBlogStorage(getStorageClient = getClient) {
  function assertUrl(url) {
    const parsed = parseBlogImageUrl(url);
    if (!parsed) throw badRequest("Use an image URL from the EdgeStore blogImages bucket.");
    return parsed;
  }

  async function uploadBlogImage(file) {
    if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length ||
        file.buffer.length > maxBlogImageSize ||
        (file.size !== undefined && file.size !== file.buffer.length)) {
      throw badRequest("Featured image must be a file no larger than 5 MB.");
    }
    const format = imageFormat(file.buffer);
    if (!format || file.mimetype !== format.mimeType) {
      throw badRequest("Featured image must be a JPEG, PNG, WebP or GIF file.");
    }
    try {
      // Inspect actual image content; a MIME value or a few magic bytes alone is insufficient.
      await sharp(file.buffer, { failOn: "error", limitInputPixels: 40_000_000 }).stats();
    } catch {
      throw badRequest("Featured image is corrupt or too large to decode.");
    }

    const uploaded = await getStorageClient().upload({
      content: {
        blob: new Blob([file.buffer], { type: format.mimeType }),
        extension: format.extension,
      },
      options: { temporary: true },
    });
    // The SDK's upload response only includes custom bucket path attributes;
    // this bucket has none, so its `path` is normally an empty object.
    if (!validateBlogImageUrl(uploaded?.url) || uploaded.size !== file.buffer.length) {
      throw new Error("EdgeStore returned invalid featured image details.");
    }
    return uploaded.url;
  }

  async function confirmBlogImageUrl(url, expectedSize) {
    assertUrl(url);
    const storage = getStorageClient();
    if (expectedSize !== undefined) {
      // The server just uploaded these exact bytes and checked the SDK's size
      // response. EdgeStore can still be processing the file, so getFile may
      // briefly return 404; confirmation itself does not need that lookup.
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxBlogImageSize) {
        throw badRequest("The featured image size is invalid.");
      }
      const confirmed = await storage.confirmUpload({ url });
      if (confirmed?.success !== true) throw new Error("EdgeStore did not confirm the featured image upload.");
      return { url, size: expectedSize };
    }
    // For a supplied URL, verify it belongs to this EdgeStore project and
    // remains within the blog image size limit before confirming it.
    const file = await storage.getFile({ url });
    if (file?.url !== url || !Number.isSafeInteger(file.size) ||
        file.size < 1 || file.size > maxBlogImageSize) {
      throw badRequest("The featured image could not be verified in EdgeStore.");
    }
    const confirmed = await storage.confirmUpload({ url });
    if (confirmed?.success !== true) throw new Error("EdgeStore did not confirm the featured image upload.");
    return file;
  }

  async function deleteBlogImage(url) {
    assertUrl(url);
    const storage = getStorageClient();
    try {
      const deleted = await storage.deleteFile({ url });
      if (deleted?.success !== true) throw new Error("EdgeStore did not confirm featured image deletion.");
    } catch (error) {
      // The SDK drops HTTP status from errors, so a failed delete could mean
      // that an earlier retry already removed the file. The bucket has no
      // custom path fields: inspect every page rather than filtering uploadId.
      const pageSize = 100;
      let totalPages;
      let totalCount;
      const urls = [];
      for (let page = 1; page === 1 || page <= totalPages; page++) {
        const result = await storage.listFiles({
          pagination: { currentPage: page, pageSize },
        });
        const pagination = result?.pagination;
        if (!Array.isArray(result?.data) || !pagination ||
            pagination.currentPage !== page ||
            !Number.isInteger(pagination.totalPages) || pagination.totalPages < 0 ||
            pagination.totalPages > 1000 ||
            !Number.isInteger(pagination.totalCount) || pagination.totalCount < 0 ||
            result.data.length > pageSize ||
            result.data.some(file => !file || typeof file.url !== "string" || !file.url)) {
          throw error;
        }
        if (page === 1) {
          totalPages = pagination.totalPages;
          totalCount = pagination.totalCount;
        } else if (pagination.totalPages !== totalPages || pagination.totalCount !== totalCount) {
          throw error;
        }
        urls.push(...result.data.map(file => file.url));
        if (urls.includes(url)) throw error;
      }
      if (urls.length !== totalCount || new Set(urls).size !== urls.length) throw error;
    }
  }

  return { uploadBlogImage, confirmBlogImageUrl, deleteBlogImage };
}

module.exports = {
  maxBlogImageSize,
  validateBlogImageUrl,
  createBlogStorage,
  ...createBlogStorage(),
};
