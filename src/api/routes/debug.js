"use strict";

const {
  DEBUG_TRACE_LIMIT,
  getDebugTraces,
  clearDebugTraces,
} = require("../../state");

function registerDebugRoutes(app, authMiddleware) {
  app.get("/api/debug/traces", authMiddleware, (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || DEBUG_TRACE_LIMIT, DEBUG_TRACE_LIMIT));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      traces: getDebugTraces(limit),
      retention: {
        type: "memory-only",
        maxTraces: DEBUG_TRACE_LIMIT,
        resetsOnDeploy: true,
      },
    });
  });

  app.delete("/api/debug/traces", authMiddleware, (_req, res) => {
    res.json({ success: true, cleared: clearDebugTraces() });
  });
}

module.exports = { registerDebugRoutes };
