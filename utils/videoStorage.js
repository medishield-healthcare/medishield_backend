const { initEdgeStore } = require("@edgestore/server");
const { initEdgeStoreClient } = require("@edgestore/server/core");

const maxVideoSize = 100 * 1024 * 1024;
const uuidPattern = "[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}";
const videoPathPattern = new RegExp(`^/[\\w-]+/videos/_public/(${uuidPattern})/[\\w.-]+$`, "i");

function parseVideoUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const match = videoPathPattern.exec(url.pathname);
    if (url.protocol !== "https:" || url.hostname !== "files.edgestore.dev" ||
        url.port || url.username || url.password || url.search || url.hash ||
        url.href !== value || !match) return null;
    return { uploadId: match[1] };
  } catch {
    return null;
  }
}

function validateVideoUrl(url) {
  return parseVideoUrl(url) !== null;
}

let client;
function getClient() {
  // Initialize lazily so a missing video setting does not stop unrelated APIs.
  if (!process.env.EDGE_STORE_ACCESS_KEY || !process.env.EDGE_STORE_SECRET_KEY) {
    const error = new Error("Configure EDGE_STORE_ACCESS_KEY and EDGE_STORE_SECRET_KEY on the backend.");
    error.statusCode = 503;
    throw error;
  }
  if (!client) {
    const es = initEdgeStore.create();
    client = initEdgeStoreClient({
      router: es.router({ videos: es.fileBucket() }),
    }).videos;
  }
  return client;
}

// The injectable client keeps failure/retry tests independent of live storage.
function createVideoStorage(getStorageClient = getClient) {
  function assertUrl(url) {
    const parsed = parseVideoUrl(url);
    if (!parsed) throw new Error("Use a video URL uploaded by this admin application.");
    return parsed;
  }

  async function confirmVideoUpload(url, expectedSize) {
    const { uploadId } = assertUrl(url);
    const storage = getStorageClient();
    // The authenticated SDK checks that this file belongs to the configured project.
    const file = await storage.getFile({ url });
    if (file.url !== url || file.path?.uploadId !== uploadId ||
        !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxVideoSize) {
      throw new Error("The uploaded video could not be verified.");
    }
    if (expectedSize !== undefined && file.size !== expectedSize) {
      throw Object.assign(new Error("The file size does not match the uploaded video."), { statusCode: 400 });
    }
    const result = await storage.confirmUpload({ url });
    if (result?.success !== true) throw new Error("EdgeStore did not confirm the video upload.");
    return file;
  }

  async function deleteVideoFile(url) {
    const { uploadId } = assertUrl(url);
    const storage = getStorageClient();
    try {
      const result = await storage.deleteFile({ url });
      if (result?.success !== true) throw new Error("EdgeStore did not confirm video deletion.");
    } catch (error) {
      // SDK 0.1.6 drops HTTP status from errors. Never guess that an error means
      // 'not found'. Verify absence in this upload's unique folder before allowing
      // a retry to remove the MongoDB record after an earlier successful deletion.
      const result = await storage.listFiles({
        filter: { path: { uploadId } },
        pagination: { currentPage: 1, pageSize: 100 },
      });
      const pagination = result?.pagination;
      if (!Array.isArray(result?.data) || !pagination ||
          pagination.currentPage !== 1 ||
          !Number.isInteger(pagination.totalPages) || pagination.totalPages < 0 ||
          pagination.totalPages > 1 ||
          !Number.isInteger(pagination.totalCount) || pagination.totalCount < 0 ||
          pagination.totalCount !== result.data.length ||
          result.data.some(file => file.path?.uploadId !== uploadId || file.url === url) ||
          new Set(result.data.map(file => file.url)).size !== result.data.length) {
        throw error;
      }
    }
  }

  return { confirmVideoUpload, deleteVideoFile };
}

module.exports = {
  maxVideoSize,
  validateVideoUrl,
  createVideoStorage,
  ...createVideoStorage(),
};
