const test = require("node:test");
const assert = require("node:assert/strict");
const { createVideoStorage, validateVideoUrl, maxVideoSize } = require("../utils/videoStorage");

const uploadId = "41a2a019-2556-4a49-a5c9-8c1ad01fef6f";
const url = `https://files.edgestore.dev/project/videos/_public/${uploadId}/clip.mp4`;
const file = { url, size: 100, path: { uploadId } };
const emptyFolder = { data: [], pagination: { currentPage: 1, totalPages: 0, totalCount: 0 } };

test("only canonical video bucket URLs are accepted", () => {
  assert.equal(validateVideoUrl(url), true);
  for (const invalid of [null, "", url.replace("https:", "http:"),
    url.replace("files.edgestore.dev", "example.com"),
    url.replace("videos", "publicFiles"), url.replace("videos", "%76ideos"),
    url.replace(`${uploadId}/`, ""), `${url}?download=1`, `${url}#fragment`,
    url.replace("https://", "https://user:password@"),
    url.replace("/clip.mp4", "/../clip.mp4")]) {
    assert.equal(validateVideoUrl(invalid), false);
  }
});

test("verifies the uploaded file before confirming it", async () => {
  const calls = [];
  const storage = createVideoStorage(() => ({
    getFile: async args => { calls.push(["get", args]); return file; },
    confirmUpload: async args => { calls.push(["confirm", args]); return { success: true }; },
  }));
  assert.deepEqual(await storage.confirmVideoUpload(url), file);
  assert.deepEqual(calls, [["get", { url }], ["confirm", { url }]]);
});

test("rejects incorrect file metadata or unsuccessful confirmation", async () => {
  for (const invalid of [{ ...file, size: 0 }, { ...file, size: maxVideoSize + 1 },
    { ...file, path: {} }, { ...file, url: "https://example.com/video.mp4" }]) {
    const storage = createVideoStorage(() => ({ getFile: async () => invalid }));
    await assert.rejects(storage.confirmVideoUpload(url), /verified/);
  }
  const storage = createVideoStorage(() => ({
    getFile: async () => file, confirmUpload: async () => ({ success: false }),
  }));
  await assert.rejects(storage.confirmVideoUpload(url), /did not confirm/);
});

test("successful deletion does not perform an absence lookup", async () => {
  const storage = createVideoStorage(() => ({ deleteFile: async () => ({ success: true }) }));
  await storage.deleteVideoFile(url);
});

test("mismatched claimed size fails before making a temporary upload permanent", async () => {
  const storage = createVideoStorage(() => ({ getFile: async () => file }));
  await assert.rejects(storage.confirmVideoUpload(url, 200), { statusCode: 400 });
});

test("retry succeeds when a complete folder lookup confirms the file is absent", async () => {
  const storage = createVideoStorage(() => ({
    deleteFile: async () => { throw new Error("previous deletion already removed the file"); },
    listFiles: async args => {
      assert.deepEqual(args.filter, { path: { uploadId } });
      return emptyFolder;
    },
  }));
  await storage.deleteVideoFile(url);
});

test("storage errors cannot remove a database record while a file remains or lookup is incomplete", async () => {
  for (const lookup of [
    { data: [file], pagination: { currentPage: 1, totalPages: 1, totalCount: 1 } },
    { ...emptyFolder, pagination: { currentPage: 1, totalPages: 2, totalCount: 101 } },
    { ...emptyFolder, pagination: { currentPage: 2, totalPages: 2, totalCount: 0 } },
    { ...emptyFolder, pagination: { currentPage: 1, totalPages: 1, totalCount: 1 } },
    { data: [null], pagination: { currentPage: 1, totalPages: 1, totalCount: 1 } },
    {},
  ]) {
    const storage = createVideoStorage(() => ({
      deleteFile: async () => ({ success: false }), listFiles: async () => lookup,
    }));
    await assert.rejects(storage.deleteVideoFile(url));
  }
  const storage = createVideoStorage(() => ({
    deleteFile: async () => { throw new Error("connection failed"); },
    listFiles: async () => { throw new Error("unauthorized"); },
  }));
  await assert.rejects(storage.deleteVideoFile(url), /unauthorized/);
});
