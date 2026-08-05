"use strict";

const { runtime, addToFeed } = require("../../state");
const { getAllChatIds } = require("../../storage");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function registerAnnouncementRoutes(app, authMiddleware) {
  app.post("/api/announce", authMiddleware, async (req, res) => {
    try {
      const { message, sendToDMs, sendToGroups } = req.body;
      if (!message) return res.status(400).json({ error: "Message is required" });
      if (!sendToDMs && !sendToGroups) {
        return res.status(400).json({ error: "Select at least one target" });
      }

      const socket = runtime.botSocket;
      if (!socket) return res.status(503).json({ error: "Bot is not connected" });

      const chatIds = await getAllChatIds();
      const targets = chatIds.filter((chatId) => {
        const isGroup = chatId.endsWith("@g.us");
        return (isGroup && sendToGroups) || (!isGroup && sendToDMs);
      });

      let sent = 0;
      let failed = 0;
      for (let index = 0; index < targets.length; index++) {
        const chatId = targets[index];
        try {
          await socket.sendMessage(chatId, { text: message });
          sent++;
          console.log(`[announce] Sent to ${chatId}`);
          addToFeed({ type: "system", message: `Announcement sent to ${chatId}` });
        } catch (error) {
          failed++;
          console.error(`[announce] Failed to send to ${chatId}:`, error.message);
        }

        if (index < targets.length - 1) {
          await sleep(2000 + Math.floor(Math.random() * 2000));
        }
      }

      return res.json({ success: true, sent, failed, total: targets.length });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });
}

module.exports = { registerAnnouncementRoutes };
