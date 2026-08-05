"use strict";

function normalizeJid(jid) {
  return typeof jid === "string" ? jid.replace(/:\d+/, "") : "";
}

function getMessageText(msg) {
  const message = msg.message;
  if (!message) return "";
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

function getContextInfo(msg) {
  return (
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    {}
  );
}

function getSenderName(msg) {
  return msg.pushName || msg.key.participant?.split("@")[0] || "there";
}

function isBotMentionedOrReplied(msg, botJid, botLid) {
  const cleanBotJid = normalizeJid(botJid);
  const cleanBotLid = normalizeJid(botLid);
  const botNumber = cleanBotJid.split("@")[0];
  const context = getContextInfo(msg);

  for (const mentionedJid of context.mentionedJid || []) {
    const cleanMention = normalizeJid(mentionedJid);
    if (cleanMention === cleanBotJid || (cleanBotLid && cleanMention === cleanBotLid)) return true;
  }

  const quotedSender = normalizeJid(context.participant || context.remoteJid);
  if (quotedSender === cleanBotJid || (cleanBotLid && quotedSender === cleanBotLid)) return true;

  return Boolean(botNumber && getMessageText(msg).includes(botNumber));
}

module.exports = {
  normalizeJid,
  getMessageText,
  getContextInfo,
  getSenderName,
  isBotMentionedOrReplied,
};
