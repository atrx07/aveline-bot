"use strict";

const { groqClients, VALID_MOODS } = require("../../config");
const { stats, liveFeed, runtime, addToFeed } = require("../../state");
const {
  purgeAllMemory,
  purgeChatMemory,
  saveMood,
} = require("../../storage");
const {
  listCanonicalChats,
  resetCanonicalMood,
  toggleCanonicalBlacklist,
} = require("../../canonical-members");
const { updateRelationshipAdmin } = require("../../relationship/admin");
const { login } = require("../auth");

function sendRouteError(res, error) {
  res.status(Number(error?.status) || 500).json({ error: error?.message || "Request failed" });
}

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
      sendRouteError(res, error);
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
      sendRouteError(res, error);
    }
  });

  app.post("/api/purge/:chatId", authMiddleware, async (req, res) => {
    try {
      const chatId = decodeURIComponent(req.params.chatId);
      await purgeChatMemory(chatId);
      addToFeed({ type: "system", message: `Memory purged for ${chatId}` });
      res.json({ success: true });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  app.post("/api/mood/:chatId", authMiddleware, async (req, res) => {
    try {
      await resetCanonicalMood(decodeURIComponent(req.params.chatId));
      res.json({ success: true });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  app.post("/api/admin/mood/:scope", authMiddleware, async (req, res) => {
    try {
      const scope = decodeURIComponent(req.params.scope);
      const mood = req.body?.mood;
      if (!VALID_MOODS.includes(mood)) {
        const error = new Error("Invalid mood");
        error.status = 400;
        throw error;
      }

      await saveMood(scope, mood);
      addToFeed({ type: "system", message: `Mood override for ${scope}: ${mood}` });
      res.json({ success: true, scope, mood });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  app.post("/api/admin/relationship/:personId", authMiddleware, async (req, res) => {
    try {
      const personId = decodeURIComponent(req.params.personId);
      const relationship = await updateRelationshipAdmin(personId, req.body || {});
      addToFeed({
        type: "system",
        message: req.body?.reset === true
          ? `Relationship reset for ${personId}`
          : `Relationship override updated for ${personId}`,
      });
      res.json({ success: true, relationship });
    } catch (error) {
      sendRouteError(res, error);
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
      sendRouteError(res, error);
    }
  });
}

module.exports = { registerDashboardRoutes };
