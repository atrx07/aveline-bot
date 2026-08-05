"use strict";

const express = require("express");
const { corsMiddleware } = require("./middleware");
const { authMiddleware } = require("./auth");
const { registerDashboardRoutes } = require("./routes/dashboard");
const { registerStickerRoutes } = require("./routes/stickers");
const { registerAnnouncementRoutes } = require("./routes/announce");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(corsMiddleware);

  registerDashboardRoutes(app, authMiddleware);
  registerStickerRoutes(app, authMiddleware);
  registerAnnouncementRoutes(app, authMiddleware);

  app.get("/", (_req, res) => res.send("ok"));
  return app;
}

module.exports = { createApp };
