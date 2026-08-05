"use strict";

const { IdentityStore } = require("../../identity-store");
const { runtime } = require("../state");

const identityStore = new IdentityStore();
const attachedSockets = new WeakSet();
const groupCache = new Map();
const GROUP_CACHE_TTL = 5 * 60 * 1000;

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "Unknown error").slice(0, 2000),
  };
}

function innerMessage(message) {
  let current = message || null;
  const wrappers = [
    "ephemeralMessage",
    "viewOnceMessage",
    "viewOnceMessageV2",
    "viewOnceMessageV2Extension",
    "documentWithCaptionMessage",
  ];

  for (let depth = 0; depth < 6 && current; depth++) {
    const wrapper = wrappers.find((key) => current?.[key]?.message);
    if (!wrapper) break;
    current = current[wrapper].message;
  }

  return current || {};
}

function textSlot(msg) {
  const message = innerMessage(msg?.message);
  if (typeof message.conversation === "string") {
    return { target: message, key: "conversation" };
  }
  if (typeof message.extendedTextMessage?.text === "string") {
    return { target: message.extendedTextMessage, key: "text" };
  }
  if (typeof message.imageMessage?.caption === "string") {
    return { target: message.imageMessage, key: "caption" };
  }
  if (typeof message.videoMessage?.caption === "string") {
    return { target: message.videoMessage, key: "caption" };
  }
  if (typeof message.documentMessage?.caption === "string") {
    return { target: message.documentMessage, key: "caption" };
  }
  return null;
}

function getRawText(msg) {
  const slot = textSlot(msg);
  return slot ? slot.target[slot.key] : "";
}

function setParsedText(msg, text) {
  const slot = textSlot(msg);
  if (slot) slot.target[slot.key] = text;
}

function getContextInfo(msg) {
  const message = innerMessage(msg?.message);
  const candidates = [
    message.extendedTextMessage,
    message.imageMessage,
    message.videoMessage,
    message.documentMessage,
    message.audioMessage,
    message.stickerMessage,
    message.contactMessage,
    message.locationMessage,
  ];
  return candidates.find((entry) => entry?.contextInfo)?.contextInfo || {};
}

function rawMentionTokens(text) {
  const tokens = [];
  const pattern = /@(\d{5,})/g;
  let match;
  while ((match = pattern.exec(text || ""))) {
    tokens.push({
      local: match[1],
      rawToken: match[0],
      start: match.index,
      end: match.index + match[0].length,
      assigned: false,
    });
  }
  return tokens;
}

function cleanSpacing(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([?!.,;:])/g, "$1")
    .trim();
}

function applyMentionSteps(text, steps, preserveBotName) {
  let output = String(text || "");
  const ordered = [...steps].sort((a, b) => b.start - a.start);

  for (const step of ordered) {
    const replacement = step.isBot
      ? (preserveBotName ? "@Aveline" : "")
      : `@${step.resolvedName || "someone"}`;
    output = output.slice(0, step.start) + replacement + output.slice(step.end);
  }

  return cleanSpacing(output);
}

async function ensureGroupMetadata(sock, groupId, force = false) {
  if (!groupId?.endsWith("@g.us") || typeof sock?.groupMetadata !== "function") return null;
  const cached = groupCache.get(groupId);
  if (!force && cached && Date.now() - cached.at < GROUP_CACHE_TTL) return cached.metadata;

  try {
    const metadata = await sock.groupMetadata(groupId);
    groupCache.set(groupId, { metadata, at: Date.now() });
    if (metadata?.subject) identityStore.chatNames.set(groupId, metadata.subject);
    await identityStore.learnGroup(metadata, groupId);
    return metadata;
  } catch (error) {
    runtime.debugPipeline.lastIdentityError = safeError(error);
    return cached?.metadata || null;
  }
}

async function canonicalId(alias) {
  return alias ? identityStore.aliasPersonId(alias) : null;
}

async function sameCanonicalIdentity(a, b) {
  const na = identityStore.normalize(a);
  const nb = identityStore.normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [aId, bId] = await Promise.all([canonicalId(na), canonicalId(nb)]);
  return Boolean(aId && bId && aId === bId);
}

async function isBotIdentity(jid, botAliases) {
  const normalized = identityStore.normalize(jid);
  if (!normalized) return false;
  if (botAliases.includes(normalized)) return true;
  for (const alias of botAliases) {
    if (await sameCanonicalIdentity(normalized, alias)) return true;
  }
  return false;
}

async function aliasMatchesToken(jid, tokenLocal) {
  const normalized = identityStore.normalize(jid);
  if (!normalized) return false;
  if (normalized.split("@")[0] === tokenLocal) return true;

  const jidPerson = await canonicalId(normalized);
  if (!jidPerson) return false;
  for (const candidate of [`${tokenLocal}@s.whatsapp.net`, `${tokenLocal}@lid`]) {
    const candidatePerson = await canonicalId(candidate);
    if (candidatePerson && candidatePerson === jidPerson) return true;
  }
  return false;
}

async function resolveMentionSteps(sock, msg, rawText, mentionedJids, botAliases) {
  const chatId = msg?.key?.remoteJid || null;
  const tokens = rawMentionTokens(rawText);
  const assignments = new Map();
  const unassignedMentions = new Set(mentionedJids.map((_, index) => index));

  for (const token of tokens) {
    const mentionIndex = mentionedJids.findIndex((jid, index) =>
      unassignedMentions.has(index) && jid.split("@")[0] === token.local);
    if (mentionIndex >= 0) {
      assignments.set(token, { jid: mentionedJids[mentionIndex], strategy: "exact-token" });
      token.assigned = true;
      unassignedMentions.delete(mentionIndex);
    }
  }

  for (const token of tokens.filter((entry) => !entry.assigned)) {
    let matchedIndex = -1;
    for (const index of unassignedMentions) {
      if (await aliasMatchesToken(mentionedJids[index], token.local)) {
        matchedIndex = index;
        break;
      }
    }
    if (matchedIndex >= 0) {
      assignments.set(token, { jid: mentionedJids[matchedIndex], strategy: "canonical-alias" });
      token.assigned = true;
      unassignedMentions.delete(matchedIndex);
    }
  }

  const remainingTokens = tokens.filter((entry) => !entry.assigned);
  const remainingMentions = [...unassignedMentions];
  for (let index = 0; index < Math.min(remainingTokens.length, remainingMentions.length); index++) {
    const token = remainingTokens[index];
    const mentionIndex = remainingMentions[index];
    assignments.set(token, { jid: mentionedJids[mentionIndex], strategy: "metadata-order" });
    token.assigned = true;
    unassignedMentions.delete(mentionIndex);
  }

  const steps = [];
  let unresolvedNamedMention = false;

  for (const token of tokens) {
    const assignment = assignments.get(token) || { jid: null, strategy: "raw-token-safety-net" };
    const isBot = assignment.jid
      ? await isBotIdentity(assignment.jid, botAliases)
      : botAliases.some((alias) => alias.split("@")[0] === token.local);
    let resolvedName = isBot ? "Aveline" : null;

    if (!isBot && assignment.jid) {
      resolvedName = await identityStore.mentionName(assignment.jid, chatId);
      if (!resolvedName) unresolvedNamedMention = true;
    }

    steps.push({
      jid: assignment.jid,
      rawToken: token.rawToken,
      localToken: token.local,
      start: token.start,
      end: token.end,
      matchStrategy: assignment.strategy,
      isBot,
      resolvedName: resolvedName || null,
      action: isBot
        ? "remove Aveline trigger"
        : resolvedName
          ? "replace internal mention with display name"
          : "replace unresolved internal mention with @someone",
      replacement: isBot ? "" : `@${resolvedName || "someone"}`,
    });
  }

  if (unresolvedNamedMention && chatId?.endsWith("@g.us")) {
    await ensureGroupMetadata(sock, chatId, true);
    for (const step of steps) {
      if (step.isBot || step.resolvedName || !step.jid) continue;
      const resolvedName = await identityStore.mentionName(step.jid, chatId);
      if (resolvedName) {
        step.resolvedName = resolvedName;
        step.action = "replace internal mention with display name after metadata refresh";
        step.replacement = `@${resolvedName}`;
      }
    }
  }

  return steps;
}

async function prepareIncomingMessage(sock, msg) {
  const rawText = getRawText(msg);
  const chatId = msg?.key?.remoteJid || null;
  const isGroup = Boolean(chatId?.endsWith("@g.us"));
  const contextInfo = getContextInfo(msg);
  const mentionedJids = identityStore.unique(contextInfo?.mentionedJid || []);
  const botAliases = identityStore.botAliases(sock);

  if (botAliases.length) {
    await identityStore.upsert({
      aliases: botAliases,
      name: "Aveline",
      source: "botIdentity",
      priority: 1000,
      presence: false,
    });
  }

  const metadata = isGroup ? await ensureGroupMetadata(sock, chatId) : null;
  const senderAliases = identityStore.senderAliases(msg);
  const groupName = metadata?.subject || await identityStore.chatName(chatId, isGroup);
  const person = await identityStore.upsert({
    aliases: senderAliases,
    name: identityStore.cleanName(msg?.pushName),
    source: "pushName",
    priority: 60,
    chatId,
    chatName: groupName,
    chatType: isGroup ? "group" : "dm",
  });

  if (person?.displayName) msg.pushName = person.displayName;

  const mentionSteps = await resolveMentionSteps(sock, msg, rawText, mentionedJids, botAliases);
  let sanitizedText = applyMentionSteps(rawText, mentionSteps, false);
  const userVisibleEstimate = applyMentionSteps(rawText, mentionSteps, true) || rawText;

  sanitizedText = cleanSpacing(sanitizedText.replace(/@\d{5,}/g, "@someone"));
  if (!sanitizedText && mentionedJids.length) {
    sanitizedText = "[The user mentioned Aveline to get her attention.]";
  }
  setParsedText(msg, sanitizedText);

  const identityPrompt = identityStore.prompt(person, chatId);
  runtime.debugPipeline.lastPreparedAt = Date.now();
  runtime.debugPipeline.lastRawText = rawText.slice(0, 300);
  runtime.debugPipeline.lastParsedText = sanitizedText.slice(0, 300);

  return {
    rawText,
    sanitizedText,
    userVisibleEstimate,
    contextInfo,
    mentionedJids,
    mentionSteps,
    botAliases,
    senderAliases,
    person,
    identityPrompt,
    groupName,
    isGroup,
    chatId,
    messageType: Object.keys(innerMessage(msg?.message))[0] || "unknown",
  };
}

function emergencySanitize(msg) {
  const rawText = getRawText(msg);
  let sanitizedText = cleanSpacing(rawText.replace(/@\d{5,}/g, "@someone"));
  if (!sanitizedText && rawText) sanitizedText = rawText;
  setParsedText(msg, sanitizedText);
  return { rawText, sanitizedText };
}

function attachIdentityListeners(sock) {
  if (!sock?.ev || attachedSockets.has(sock)) return;
  attachedSockets.add(sock);
  runtime.debugPipeline.identityListenersAttached = true;
  runtime.debugPipeline.identityAttachedAt = Date.now();

  sock.ev.on("contacts.upsert", (contacts) => identityStore.learnContacts(contacts).catch((error) => {
    runtime.debugPipeline.lastIdentityError = safeError(error);
  }));
  sock.ev.on("contacts.update", (contacts) => identityStore.learnContacts(contacts).catch((error) => {
    runtime.debugPipeline.lastIdentityError = safeError(error);
  }));
  sock.ev.on("messaging-history.set", (history) => identityStore.learnContacts(history?.contacts).catch((error) => {
    runtime.debugPipeline.lastIdentityError = safeError(error);
  }));
  sock.ev.on("chats.phoneNumberShare", (mapping) => identityStore.upsert({
    aliases: identityStore.aliasesFrom(mapping),
    presence: false,
  }).catch((error) => {
    runtime.debugPipeline.lastIdentityError = safeError(error);
  }));
  sock.ev.on("groups.upsert", (groups) => Promise.all(
    (groups || []).map((metadata) => {
      if (metadata?.id) groupCache.set(metadata.id, { metadata, at: Date.now() });
      return identityStore.learnGroup(metadata, metadata?.id);
    })
  ).catch((error) => {
    runtime.debugPipeline.lastIdentityError = safeError(error);
  }));
  sock.ev.on("groups.update", (groups) => {
    for (const metadata of groups || []) {
      if (metadata?.id) groupCache.delete(metadata.id);
    }
  });
}

module.exports = {
  identityStore,
  attachIdentityListeners,
  prepareIncomingMessage,
  emergencySanitize,
  getRawText,
  getContextInfo,
  safeError,
};
