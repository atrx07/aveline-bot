"use strict";

const { groqClients } = require("../../config");
const { stats, liveFeed, runtime, addToFeed } = require("../../state");
const {
  purgeAllMemory,
  purgeChatMemory,
} = require("../../storage");
const {
  listCanonicalChats,
  resetCanonicalMood,
  toggleCanonicalBlacklist,
} = require("../../canonical-members");
const { login } = require("../auth");

function registerDashboardRoutes(app, authMiddleware) {
  app.post("/api/login", login);

  app.get("/api/status", authMiddleware, (_req, res) => {
    res.json({
      online: Boolean(runtime.botSocket),
      paused: runtime.botPaused,
      uptime: Date.now() - stats.startedAt,
      lastMessageAt: stats.lastMessageAt,
      keysLoaded: groqClients.length,
    });
  });

  app.get("/api/stats", authMiddleware, (_req, res) => {
    const avgResponseTime = stats.responseTimes.length
      ? Math.round(stats.responseTimes.reduce((sum, value) => sum + value, 0) / stats.responseTimes.length)
      : 0;

    res.json({
      totalMessages: stats.totalMessages,
      messagesToday: stats.messagesToday,
      avgResponseTime,
      modelUsage: stats.modelUsage,
      keyUsage: stats.keyUsage,
      rateLimitHits: stats.rateLimitHits,
    });
  });

  app.get("/api/chats", authMiddleware, async (_req, res) => {
    try {
      res.json(await listCanonicalChats());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/feed", authMiddleware, (_req, res) => res.json(liveFeed));

  app.post("/api/toggle", authMiddleware, (_req, res) => {
    runtime.botPaused = !runtime.botPaused;
    console.log(`[dashboard] Bot ${runtime.botPaused ? "paused" : "resumed"}`);
    addToFeed({
      type: "system",
      message: `Bot ${runtime.botPaused ? "paused" : "resumed"} via dashboard`,
    });
    res.json({ paused: runtime.botPaused });
  });

  app.post("/api/purge", authMiddleware, async (_req, res) => {
    try {
      const purged = await purgeAllMemory();
      addToFeed({ type: "system", message: "All memory purged via dashboard" });
      res.json({ success: true, purged });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/purge/:chatId", authMiddleware, async (req, res) => {
    try {
      const chatId = decodeURIComponent(req.params.chatId);
      await purgeChatMemory(chatId);
      addToFeed({ type: "system", message: `Memory purged for ${chatId}` });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/mood/:chatId", authMiddleware, async (req, res) => {
    try {
      await resetCanonicalMood(decodeURIComponent(req.params.chatId));
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/blacklist/:chatId", authMiddleware, async (req, res) => {
    try {
      const chatId = decodeURIComponent(req.params.chatId);
      const blacklisted = await toggleCanonicalBlacklist(chatId);
      addToFeed({
        type: "system",
        message: `${chatId} ${blacklisted ? "added to" : "removed from"} blacklist`,
      });
      res.json({ blacklisted });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerDashboardRoutes };
