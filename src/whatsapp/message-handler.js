"use strict";

const crypto = require("crypto");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const { stats, runtime, addToFeed } = require("../state");
const {
  saveName,
  saveGroupMember,
  saveMood,
  isStickerEnabled,
  getRandomSticker,
  saveStandbySticker,
  isBlacklisted,
  saveStats,
} = require("../storage");
const { detectMood, getAIReply } = require("../ai/service");
const {
  normalizeJid,
  getMessageText,
  getSenderName,
  isBotMentionedOrReplied,
} = require("./message-utils");

function optionalBase64(value) {
  return value ? Buffer.from(value).toString("base64") : null;
}

async function captureSticker(msg, from) {
  const sticker = msg.message.stickerMessage;
  const id = crypto.randomUUID();
  const stream = await downloadContentFromMessage(sticker, "sticker");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);

  await saveStandbySticker(id, {
    base64: Buffer.concat(chunks).toString("base64"),
    mimetype: "image/webp",
    isAnimated: Boolean(sticker.isAnimated),
    capturedAt: Date.now(),
    from,
    fileEncSha256: optionalBase64(sticker.fileEncSha256),
    fileSha256: optionalBase64(sticker.fileSha256),
    fileLength: sticker.fileLength,
    mediaKey: optionalBase64(sticker.mediaKey),
    directPath: sticker.directPath,
    url: sticker.url,
  });

  console.log(`[sticker] Captured and stored sticker ${id} from ${from}`);
  addToFeed({ type: "system", message: `Sticker captured from ${from}` });
}

async function learnConversationNames(sock, msg, from, isGroup, senderName) {
  if (!isGroup) {
    if (senderName !== "there") await saveName(from, senderName);
    return { userId: null, groupName: null };
  }

  let groupName = null;
  try {
    const metadata = await sock.groupMetadata(from);
    groupName = metadata?.subject || null;
    if (groupName) await saveName(from, groupName);
  } catch {}

  const userId = normalizeJid(msg.key.participant);
  if (userId) await saveGroupMember(from, userId, senderName);
  return { userId, groupName };
}

async function maybeSendMoodSticker(sock, from, mood) {
  const allowed = await isStickerEnabled(from);
  if (!allowed || Math.random() >= 0.25) return;

  try {
    const sticker = await getRandomSticker(mood);
    if (sticker?.base64) {
      await sock.sendMessage(from, { sticker: Buffer.from(sticker.base64, "base64") });
    }
  } catch (error) {
    console.error("[sticker] Failed to send:", error.message);
  }
}

async function handleAI(sock, msg) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  const senderName = getSenderName(msg);
  const text = getMessageText(msg);
  const startedAt = Date.now();
  const { userId, groupName } = await learnConversationNames(sock, msg, from, isGroup, senderName);

  try {
    await sock.sendPresenceUpdate("composing", from);
    const mood = await detectMood(text);
    await saveMood(from, mood);
    if (isGroup && userId) await saveMood(`${from}:${userId}`, mood);

    const reply = await getAIReply(from, text, senderName, mood);
    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    await maybeSendMoodSticker(sock, from, mood);

    const responseTime = Date.now() - startedAt;
    stats.totalMessages++;
    stats.messagesToday++;
    stats.lastMessageAt = Date.now();
    stats.responseTimes.push(responseTime);
    if (stats.responseTimes.length > 100) stats.responseTimes.shift();

    addToFeed({
      type: "message",
      from,
      name: senderName,
      groupName,
      isGroup,
      text: text.slice(0, 200),
      reply: reply.slice(0, 200),
      mood,
      responseTime,
    });

    if (stats.totalMessages % 10 === 0) await saveStats();
  } catch (error) {
    console.error("Reply error:", error);
    await sock.sendMessage(from, { text: "Oops 😅 AI couldn't respond right now." }, { quoted: msg });
  } finally {
    await sock.sendPresenceUpdate("paused", from).catch(() => {});
  }
}

async function onMessage(sock, botJid, botLid, { messages, type }) {
  if (type !== "notify" && type !== "append") return;
  if (runtime.botPaused) return;

  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe || msg.key.remoteJid === "status@broadcast") continue;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");

    if (runtime.stickerCaptureMode && msg.message.stickerMessage) {
      try {
        await captureSticker(msg, from);
      } catch (error) {
        console.error("[sticker] Failed to capture:", error.message);
      }
      continue;
    }

    const text = getMessageText(msg).trim();
    if (!text || text.length > 400) continue;
    if (isGroup && !isBotMentionedOrReplied(msg, botJid, botLid)) continue;

    if (await isBlacklisted(from)) {
      console.log(`[blacklist] Ignored message from ${from}`);
      continue;
    }

    if (isGroup) {
      const userId = normalizeJid(msg.key.participant);
      if (userId && await isBlacklisted(userId)) {
        console.log(`[blacklist] Ignored group message from member ${userId}`);
        continue;
      }
    }

    console.log(`[msg] ${from} | ${msg.pushName}: ${text}`);
    await handleAI(sock, msg);
  }
}

module.exports = { onMessage, handleAI };
