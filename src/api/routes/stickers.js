"use strict";

const { VALID_MOODS } = require("../../config");
const { runtime, addToFeed } = require("../../state");
const {
  getStandbyStickers,
  getMoodStickers,
  classifySticker,
  clearStickerKeys,
  clearAllStickers,
  deleteSticker,
  isStickerEnabled,
  setStickerEnabled,
} = require("../../storage");

function registerStickerRoutes(app, authMiddleware) {
  app.post("/api/stickers/capture", authMiddleware, (_req, res) => {
    runtime.stickerCaptureMode = !runtime.stickerCaptureMode;
    console.log(`[sticker] Capture mode ${runtime.stickerCaptureMode ? "ON" : "OFF"}`);
    addToFeed({
      type: "system",
      message: `Sticker capture mode ${runtime.stickerCaptureMode ? "enabled" : "disabled"}`,
    });
    res.json({ captureMode: runtime.stickerCaptureMode });
  });

  app.get("/api/stickers/status", authMiddleware, (_req, res) => {
    res.json({ captureMode: runtime.stickerCaptureMode });
  });

  app.get("/api/stickers/standby", authMiddleware, async (_req, res) => {
    try {
      res.json(await getStandbyStickers());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/stickers/mood/:mood", authMiddleware, async (req, res) => {
    try {
      res.json(await getMoodStickers(req.params.mood));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/stickers/classify", authMiddleware, async (req, res) => {
    try {
      const { id, mood } = req.body;
      if (!VALID_MOODS.includes(mood)) return res.status(400).json({ error: "Invalid mood" });
      if (!await classifySticker(id, mood)) return res.status(404).json({ error: "Sticker not found" });
      return res.json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/stickers/all", authMiddleware, async (_req, res) => {
    try {
      res.json({ success: true, cleared: await clearAllStickers() });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/stickers/standby/all", authMiddleware, async (_req, res) => {
    try {
      res.json({ success: true, cleared: await clearStickerKeys("sticker:standby:*") });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/stickers/mood/:mood/all", authMiddleware, async (req, res) => {
    try {
      const cleared = await clearStickerKeys(`sticker:mood:${req.params.mood}:*`);
      res.json({ success: true, cleared });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/stickers/:type/:mood/:id", authMiddleware, async (req, res) => {
    try {
      const { type, mood, id } = req.params;
      await deleteSticker(type, mood, id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/stickers/toggle/:chatId", authMiddleware, async (req, res) => {
    try {
      const chatId = decodeURIComponent(req.params.chatId);
      const enabled = !await isStickerEnabled(chatId);
      await setStickerEnabled(chatId, enabled);
      res.json({ enabled });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerStickerRoutes };
