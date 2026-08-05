"use strict";

const {
  DEBUG_TRACE_LIMIT,
  getDebugTraces,
  getDebugHealth,
  clearDebugTraces,
} = require("../../state");

function registerDebugRoutes(app, authMiddleware) {
  app.get("/api/debug/traces", authMiddleware, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || DEBUG_TRACE_LIMIT, DEBUG_TRACE_LIMIT));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      traces: getDebugTraces(limit),
      health: getDebugHealth(),
      retention: {
        type: "memory-only",
        maxTraces: DEBUG_TRACE_LIMIT,
        resetsOnDeploy: true,
      },
    });
  });

  app.get("/api/debug/health", authMiddleware, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(getDebugHealth());
  });

  app.delete("/api/debug/traces", authMiddleware, (_req, res) => {
    res.json({ success: true, cleared: clearDebugTraces(), health: getDebugHealth() });
  });
}

module.exports = { registerDebugRoutes };
