const { randomUUID } = require("node:crypto");
const Event = require("../models/eventModel");

const fieldLimits = {
  title: 200,
  shortTitle: 200,
  category: 100,
  date: 30,
  month: 30,
  fullDate: 100,
  day: 30,
  time: 100,
  location: 200,
  mode: 50,
  speaker: 200,
  designation: 200,
  description: 5000,
  eventUrl: 2048,
};
const eventFields = Object.keys(fieldLimits);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function validateId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) {
    throw httpError(400, "Invalid event ID.");
  }
  return id;
}

function validateBody(body, creating, routeId) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "A JSON object is required.");
  }
  const allowed = new Set(["id", ...eventFields]);
  const unsupportedField = Object.keys(body).find((field) => !allowed.has(field));
  if (unsupportedField) {
    throw httpError(400, `Unsupported event field: ${unsupportedField}.`);
  }
  const data = {};
  if (has(body, "id")) {
    if (typeof body.id !== "string") throw httpError(400, "id must be a string.");
    const id = validateId(body.id.trim());
    if (!creating && id !== routeId) throw httpError(400, "Event ID cannot be changed.");
    if (creating) data.id = id;
  }
  for (const field of eventFields) {
    if (!has(body, field)) continue;
    if (typeof body[field] !== "string") {
      throw httpError(400, `${field} must be a string.`);
    }
    const value = body[field].trim();
    if (value.length > fieldLimits[field]) {
      throw httpError(400, `${field} must not exceed ${fieldLimits[field]} characters.`);
    }
    data[field] = value;
  }
  if (!creating && !Object.keys(data).length) {
    throw httpError(400, "No event changes were supplied.");
  }
  if (has(data, "eventUrl") && data.eventUrl) {
    let url;
    try {
      url = new URL(data.eventUrl);
    } catch {
      throw httpError(400, "eventUrl must be an HTTP or HTTPS URL.");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw httpError(400, "eventUrl must be an HTTP or HTTPS URL.");
    }
  }
  return data;
}

function validateRequiredFields(data) {
  const missingField = eventFields.find((field) => !data[field]);
  if (missingField) throw httpError(400, `${missingField} is required.`);
}

function publicEvent(event) {
  const object = typeof event.toObject === "function" ? event.toObject() : event;
  return Object.fromEntries([
    ["id", object.id],
    ...eventFields.map((field) => [field, object[field] ?? ""]),
  ]);
}

function createEventHandlers({ Event: Model, createId = randomUUID }) {
  const wrap = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      const status = error.status || (error.code === 11000 ? 409 : error.name === "ValidationError" ? 400 : 500);
      const message = error.status ? error.message : error.code === 11000
        ? "An event with this ID already exists."
        : error.name === "ValidationError" ? "Invalid event data." : "Could not process the event request.";
      return res.status(status).json({ message });
    }
  };

  return {
    createEvent: wrap(async (req, res) => {
      const data = validateBody(req.body, true);
      validateRequiredFields(data);
      const event = await Model.create({ ...data, id: data.id || createId() });
      return res.status(201).json(publicEvent(event));
    }),

    updateEvent: wrap(async (req, res) => {
      const id = validateId(req.params.id);
      const data = validateBody(req.body, false, id);
      const current = await Model.findOne({ id });
      if (!current) throw httpError(404, "Event not found.");
      validateRequiredFields({ ...publicEvent(current), ...data });
      const event = await Model.findOneAndUpdate(
        { id }, { $set: data }, { new: true, runValidators: true }
      );
      if (!event) throw httpError(404, "Event not found.");
      return res.json(publicEvent(event));
    }),

    deleteEvent: wrap(async (req, res) => {
      const id = validateId(req.params.id);
      const event = await Model.findOneAndDelete({ id });
      if (!event) throw httpError(404, "Event not found.");
      return res.json({ message: "Event deleted.", id });
    }),

    getEvent: wrap(async (req, res) => {
      const id = validateId(req.params.id);
      const event = await Model.findOne({ id });
      if (!event) throw httpError(404, "Event not found.");
      return res.json(publicEvent(event));
    }),

    getallEvent: wrap(async (req, res) => {
      const events = await Model.find().sort({ fullDate: -1 });
      return res.json({ data: events.map(publicEvent) });
    }),
  };
}

module.exports = {
  ...createEventHandlers({ Event }),
  createEventHandlers,
};
