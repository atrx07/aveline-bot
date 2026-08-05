"use strict";

const { getRouterHealth } = require("../../ai/router-health");

function registerRouterRoutes(app, authMiddleware) {
  app.get("/api/groq/router-health", authMiddleware, async (_req, res) => {
    try {
      res.json(await getRouterHealth());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerRouterRoutes };
