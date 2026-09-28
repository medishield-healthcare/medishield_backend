const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load the modules with explicit dependency stubs: these tests never connect
// to MongoDB, authenticate real users, or call Edge Store.
function loadWithStubs(relativePath, stubs) {
  const filename = path.join(__dirname, "..", relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module,
    exports: module.exports,
    require(name) {
      if (!(name in stubs)) throw new Error(`Unexpected dependency: ${name}`);
      return stubs[name];
    },
  }, { filename });
  return module.exports;
}

const { createVideoHandlers } = loadWithStubs("controller/videoCtrl.js", {
  "../models/videoModel": {},
  "../utils/videoStorage": {},
});
const registeredRoutes = [];
const router = Object.fromEntries(["get", "post", "put", "delete"].map((method) => [
  method, (route, ...handlers) => registeredRoutes.push({ method, route, handlers }),
]));
const { createVideoAdminGuard } = loadWithStubs("routes/videoRoute.js", {
  express: { Router: () => router },
  "../middlewares/authMiddleware": { authMiddleware() {} },
  "../controller/videoCtrl": Object.fromEntries([
    "createVideo", "updateVideo", "deleteVideo", "getVideo", "getallVideo",
  ].map((name) => [name, () => {}])),
});

const id = "0123456789abcdef01234567";
const otherId = "0123456789abcdef01234568";
const urlA = "https://files.edgestore.dev/project/videos/_public/a.mp4";
const urlB = "https://files.edgestore.dev/project/videos/_public/b.mp4";
const upload = (url = urlA) => ({
  title: "Exercise guide", description: "Safe stretching", url,
  fileName: "guide.mp4", mimeType: "video/mp4", size: 1024,
});
const copy = (value) => value === undefined ? undefined : structuredClone(value);

function matches(record, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && "$ne" in value) return record[key] !== value.$ne;
    if (Array.isArray(record[key])) return record[key].includes(value);
    return record[key] === value;
  });
}

function fixture(initial = []) {
  const records = new Map(initial.map((record) => [record._id, copy(record)]));
  const events = [];
  const failures = {};
  const files = new Set([urlA, urlB]);
  let nextId = 1;
  function unique(record) {
    for (const existing of records.values()) {
      if (existing._id !== record._id && record.storageUrls.some((url) => existing.storageUrls.includes(url))) {
        throw Object.assign(new Error("duplicate file"), { code: 11000 });
      }
    }
  }
  function fail(name) {
    if (failures[name]) {
      const failure = failures[name];
      if (typeof failure === "function") return failure();
      throw failure;
    }
  }
  function apply(record, changes) {
    const updated = { ...copy(record), ...copy(changes.$set || {}) };
    for (const [key, value] of Object.entries(changes.$inc || {})) updated[key] = (updated[key] || 0) + value;
    for (const [key, value] of Object.entries(changes.$addToSet || {})) updated[key] = [...new Set([...(updated[key] || []), value])];
    for (const [key, value] of Object.entries(changes.$pull || {})) updated[key] = updated[key].filter((item) => item !== value);
    unique(updated);
    records.set(updated._id, updated);
    return copy(updated);
  }
  const Model = {
    async findOne(filter) { fail("find"); return copy([...records.values()].find((record) => matches(record, filter))) || null; },
    async findById(key) { fail("find"); return copy(records.get(key)) || null; },
    find() { return { sort: async () => { fail("find"); return copy([...records.values()]); } }; },
    async create(data) {
      fail("create");
      const record = { _id: String(nextId++).padStart(24, "0"), __v: 0, status: "active", pendingCleanupUrls: [], ...copy(data) };
      unique(record);
      records.set(record._id, record);
      events.push("database:create");
      fail("createAfterWrite");
      return copy(record);
    },
    async findOneAndUpdate(filter, changes) {
      fail("update");
      const record = [...records.values()].find((item) => matches(item, filter));
      if (!record) return null;
      const updated = apply(record, changes);
      events.push("database:update");
      fail("updateAfterWrite");
      return updated;
    },
    async updateOne(filter, changes) {
      fail("cleanupWrite");
      const record = [...records.values()].find((item) => matches(item, filter));
      if (record) apply(record, changes);
      return { matchedCount: record ? 1 : 0 };
    },
    async deleteOne(filter) {
      fail("delete");
      const record = [...records.values()].find((item) => matches(item, filter));
      if (record) records.delete(record._id);
      events.push("database:delete");
      return { deletedCount: record ? 1 : 0 };
    },
  };
  const storage = {
    maxVideoSize: 100 * 1024 * 1024,
    validateVideoUrl: (url) => /^https:\/\/files\.edgestore\.dev\/project\/videos\/_public\/[a-z]+\.mp4$/.test(url),
    async confirmVideoUpload(url) {
      events.push(`confirm:${url}`);
      fail("confirm");
      if (!files.has(url)) throw new Error("File does not exist");
      return { url, size: 1024 };
    },
    async deleteVideoFile(url) {
      events.push(`delete:${url}`);
      fail("storageDelete");
      files.delete(url);
    },
  };
  return { handlers: createVideoHandlers({ Video: Model, storage }), records, events, failures, files, Model };
}

const video = (fields = {}) => ({
  _id: id, __v: 0, status: "active", ...upload(), pendingCleanupUrls: [], storageUrls: [urlA], ...fields,
});

async function request(handler, body, params = {}) {
  const response = {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = JSON.parse(JSON.stringify(value)); return this; },
  };
  await handler({ body, params }, response);
  return response;
}

test("create confirms the upload, stores its link, and returns only public fields", async () => {
  const app = fixture();
  const response = await request(app.handlers.createVideo, upload());
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.url, urlA);
  assert.equal(response.body.cleanupPending, false);
  assert.equal(response.body.storageUrls, undefined);
  assert.equal(response.body.__v, undefined);
  assert.deepEqual(app.events, [`confirm:${urlA}`, "database:create"]);
  assert.deepEqual([...app.records.values()][0].storageUrls, [urlA]);
});

test("invalid fields, non-video files, oversized files, and external URLs fail before storage or DB writes", async () => {
  for (const body of [
    { ...upload(), title: " " }, { ...upload(), title: "x".repeat(201) },
    { ...upload(), description: "x".repeat(5001) }, { ...upload(), size: 0 },
    { ...upload(), size: 100 * 1024 * 1024 + 1 }, { ...upload(), size: "1024" },
    { ...upload(), size: 1.5 }, { ...upload(), mimeType: "image/png" },
    { ...upload(), url: "https://example.com/movie.mp4" }, { ...upload(), status: "deleting" },
    { title: "Missing file" }, null, [],
  ]) {
    const app = fixture();
    const response = await request(app.handlers.createVideo, body);
    assert.equal(response.statusCode, 400, JSON.stringify(body));
    assert.equal(app.records.size, 0);
    assert.deepEqual(app.events, []);
  }
});

test("failed upload confirmation does not create a record", async () => {
  const app = fixture();
  app.failures.confirm = new Error("unavailable");
  assert.equal((await request(app.handlers.createVideo, upload())).statusCode, 502);
  assert.equal(app.records.size, 0);
  app.failures.confirm = Object.assign(new Error("configuration"), { statusCode: 503 });
  assert.equal((await request(app.handlers.createVideo, upload())).statusCode, 503);
});

test("an uncertain create preserves the file and retries the same URL without duplicating a record", async () => {
  const app = fixture();
  app.failures.createAfterWrite = new Error("connection lost after commit");
  assert.equal((await request(app.handlers.createVideo, upload())).statusCode, 503);
  assert.equal(app.files.has(urlA), true);
  delete app.failures.createAfterWrite;
  const retry = await request(app.handlers.createVideo, upload());
  assert.equal(retry.statusCode, 200);
  assert.equal(app.records.size, 1);
  assert.equal((await request(app.handlers.createVideo, { ...upload(), title: "Different" })).statusCode, 409);
});

test("metadata update leaves storage untouched", async () => {
  const app = fixture([video()]);
  const response = await request(app.handlers.updateVideo, { title: "New title" }, { id });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.title, "New title");
  assert.equal(response.body.url, urlA);
  assert.deepEqual(app.events, ["database:update"]);
});

test("file metadata cannot be forged during create, replacement, or a metadata-only edit", async () => {
  const app = fixture([video()]);
  for (const fields of [{ size: 100 }, { fileName: "other.mp4" }, { mimeType: "video/webm" }]) {
    assert.equal((await request(app.handlers.updateVideo, fields, { id })).statusCode, 400);
  }
  assert.equal((await request(app.handlers.updateVideo, { ...upload(urlB), size: 100 }, { id })).statusCode, 400);
  assert.equal((await request(fixture().handlers.createVideo, { ...upload(), size: 100 })).statusCode, 400);
  assert.equal(app.records.get(id).url, urlA);
});

test("replacement saves its URL before deleting the previous file", async () => {
  const app = fixture([video()]);
  const response = await request(app.handlers.updateVideo, upload(urlB), { id });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.url, urlB);
  assert.equal(response.body.cleanupPending, false);
  assert.deepEqual(app.events, [`confirm:${urlB}`, "database:update", `delete:${urlA}`]);
  assert.deepEqual(app.records.get(id).storageUrls, [urlB]);
  assert.equal(app.files.has(urlB), true);
});

test("failed or uncertain replacement writes never delete either file", async () => {
  for (const failure of ["update", "updateAfterWrite"]) {
    const app = fixture([video()]);
    app.failures[failure] = new Error("database unavailable");
    assert.equal((await request(app.handlers.updateVideo, upload(urlB), { id })).statusCode, 503);
    assert.equal(app.files.has(urlA), true);
    assert.equal(app.files.has(urlB), true);
    assert.equal(app.events.some((event) => event.startsWith("delete:")), false);
    delete app.failures[failure];
    assert.equal((await request(app.handlers.updateVideo, upload(urlB), { id })).statusCode, 200);
    assert.equal(app.records.get(id).url, urlB);
    assert.equal(app.files.has(urlA), false);
  }
});

test("cleanup failures retain durable reservations and a later save retries cleanup", async () => {
  for (const failure of ["storageDelete", "cleanupWrite"]) {
    const app = fixture([video()]);
    app.failures[failure] = new Error("unavailable");
    const response = await request(app.handlers.updateVideo, upload(urlB), { id });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.cleanupPending, true);
    assert.match(response.body.warning, /cleanup is pending/);
    assert.equal(app.records.get(id).url, urlB);
    assert.deepEqual(app.records.get(id).pendingCleanupUrls, [urlA]);
    assert.deepEqual(app.records.get(id).storageUrls, [urlA, urlB]);
    assert.equal((await request(app.handlers.createVideo, upload())).statusCode, 409);
    assert.equal((await request(app.handlers.updateVideo, upload(), { id })).statusCode, 409);
    delete app.failures[failure];
    const retry = await request(app.handlers.updateVideo, { title: "Retry cleanup" }, { id });
    assert.equal(retry.body.cleanupPending, false);
    assert.deepEqual(app.records.get(id).pendingCleanupUrls, []);
  }
});

test("optimistic update refuses concurrent changes and never deletes the original file", async () => {
  const app = fixture([video()]);
  app.failures.update = () => { app.records.get(id).__v += 1; };
  const response = await request(app.handlers.updateVideo, upload(urlB), { id });
  assert.equal(response.statusCode, 409);
  assert.equal(app.records.get(id).url, urlA);
  assert.equal(app.files.has(urlA), true);
});

test("another video's file cannot be attached by replacement", async () => {
  const app = fixture([video(), video({ _id: otherId, ...upload(urlB), storageUrls: [urlB] })]);
  const response = await request(app.handlers.updateVideo, upload(urlB), { id });
  assert.equal(response.statusCode, 409);
  assert.equal(app.records.get(id).url, urlA);
  assert.equal(app.files.has(urlA), true);
  assert.equal(app.files.has(urlB), true);
  assert.deepEqual(app.events, []);
});

test("a file awaiting another video's cleanup is rejected before confirmation", async () => {
  const app = fixture([
    video(),
    video({ _id: otherId, ...upload(urlB), pendingCleanupUrls: [urlB], storageUrls: [urlB] }),
  ]);
  const response = await request(app.handlers.updateVideo, upload(urlB), { id });
  assert.equal(response.statusCode, 409);
  assert.deepEqual(app.events, []);
});

test("delete removes current and pending files before removing the database record", async () => {
  const app = fixture([video({ pendingCleanupUrls: [urlB], storageUrls: [urlA, urlB] })]);
  const response = await request(app.handlers.deleteVideo, undefined, { id });
  assert.equal(response.statusCode, 200);
  assert.equal(app.records.size, 0);
  assert.deepEqual(app.events, ["database:update", `delete:${urlA}`, `delete:${urlB}`, "database:delete"]);
});

test("failed storage deletion keeps a retryable record and blocks updates", async () => {
  const app = fixture([video()]);
  app.failures.storageDelete = new Error("storage unavailable");
  const response = await request(app.handlers.deleteVideo, undefined, { id });
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.deletionPending, true);
  assert.equal(app.records.get(id).status, "deleting");
  assert.equal(app.files.has(urlA), true);
  assert.equal((await request(app.handlers.updateVideo, { title: "Cannot edit" }, { id })).statusCode, 409);
  delete app.failures.storageDelete;
  assert.equal((await request(app.handlers.deleteVideo, undefined, { id })).statusCode, 200);
  assert.equal(app.records.size, 0);
});

test("failed database deletion can retry already-deleted storage files", async () => {
  const app = fixture([video()]);
  app.failures.delete = new Error("database unavailable");
  const response = await request(app.handlers.deleteVideo, undefined, { id });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.deletionPending, true);
  assert.equal(app.records.get(id).status, "deleting");
  assert.equal(app.files.has(urlA), false);
  delete app.failures.delete;
  assert.equal((await request(app.handlers.deleteVideo, undefined, { id })).statusCode, 200);
  assert.equal(app.records.size, 0);
});

test("IDs, missing records, incomplete replacements, and empty updates are rejected", async () => {
  const app = fixture([video()]);
  for (const name of ["getVideo", "updateVideo", "deleteVideo"]) {
    assert.equal((await request(app.handlers[name], { title: "x" }, { id: "invalid" })).statusCode, 400);
    assert.equal((await request(app.handlers[name], { title: "x" }, { id: otherId })).statusCode, 404);
  }
  assert.equal((await request(app.handlers.updateVideo, { url: urlB }, { id })).statusCode, 400);
  assert.equal((await request(app.handlers.updateVideo, {}, { id })).statusCode, 400);
});

test("list and detail expose links and pending deletion state without internal cleanup URLs", async () => {
  const app = fixture([video({ status: "deleting", pendingCleanupUrls: [urlB], storageUrls: [urlA, urlB] })]);
  const list = await request(app.handlers.getallVideo);
  assert.equal(list.body.data.length, 1);
  const detail = await request(app.handlers.getVideo, undefined, { id });
  assert.equal(detail.body.url, urlA);
  assert.equal(detail.body.status, "deleting");
  assert.equal(detail.body.cleanupPending, true);
  assert.equal(detail.body.pendingCleanupUrls, undefined);
});

test("mutations require authentication and an admin role", async () => {
  for (const header of [undefined, "Bearer", "Bearer ", "Bearer  token", "Bearer\ttoken"]) {
    const guard = createVideoAdminGuard(() => assert.fail("Invalid headers must not reach authentication"));
    const response = await request((req, res) => guard({ headers: { authorization: header } }, res, () => assert.fail()), undefined);
    assert.equal(response.statusCode, 401);
  }
  for (const [role, expected] of [["user", 403], ["admin", 200], [null, 401]]) {
    const guard = createVideoAdminGuard((req, res, next) => {
      if (role) req.user = { role };
      next(role ? undefined : new Error("invalid token"));
    });
    let accepted = false;
    const response = await request((req, res) => guard({ headers: { authorization: "Bearer token" } }, res, () => { accepted = true; }), undefined);
    assert.equal(response.statusCode, expected);
    assert.equal(accepted, role === "admin");
  }
  for (const method of ["post", "put", "delete"]) {
    assert.equal(registeredRoutes.find((route) => route.method === method).handlers.length, 2);
  }
});
