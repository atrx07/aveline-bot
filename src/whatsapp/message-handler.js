"use strict";

const crypto = require("crypto");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const {
  stats,
  runtime,
  addToFeed,
  createDebugTrace,
  mutateDebugTrace,
  updateDebugTrace,
  noteDebugMessageSeen,
  noteDebugPreprocessError,
} = require("../state");
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
const { evaluateSystemDecision, getAIReply } = require("../ai/service");
const {
  loadRelationship,
  applyRelationshipDecision,
  publicRelationship,
} = require("../relationship/service");
const { resolveIdentity } = require("../canonical-members");
const {
  prepareIncomingMessage,
  emergencySanitize,
  getRawText,
  getContextInfo,
  safeError,
} = require("../identity/service");
const {
  normalizeJid,
  getMessageText,
  getSenderName,
  isBotMentionedOrReplied,
} = require("./message-utils");

function optionalBase64(value) {
  return value ? Buffer.from(value).toString("base64") : null;
}

function markSkipped(traceId, reason, details = null) {
  updateDebugTrace(traceId, {
    status: "skipped",
    skipReason: reason,
    skipDetails: details,
    completedAt: Date.now(),
  });
}

function messageKeySnapshot(msg) {
  return {
    remoteJid: msg?.key?.remoteJid || null,
    remoteJidAlt: msg?.key?.remoteJidAlt || null,
    participant: msg?.key?.participant || null,
    participantAlt: msg?.key?.participantAlt || null,
    participantLid: msg?.key?.participantLid || null,
    participantPn: msg?.key?.participantPn || null,
    senderLid: msg?.key?.senderLid || null,
    senderPn: msg?.key?.senderPn || null,
    fromMe: Boolean(msg?.key?.fromMe),
  };
}

function createIncomingTrace(msg, upsertType) {
  const rawText = getRawText(msg);
  const contextInfo = getContextInfo(msg);
  const chatId = msg?.key?.remoteJid || null;

  noteDebugMessageSeen();
  return createDebugTrace({
    status: "received",
    messageId: msg?.key?.id || null,
    chat: {
      id: chatId,
      isGroup: Boolean(chatId?.endsWith("@g.us")),
    },
    sender: {
      pushName: msg?.pushName || null,
      participant: msg?.key?.participant || null,
    },
    whatsapp: {
      rawText,
      userVisibleEstimate: rawText,
      messageType: Object.keys(msg?.message || {})[0] || "unknown",
      contextInfo: {
        mentionedJid: contextInfo?.mentionedJid || [],
        quotedParticipant: contextInfo?.participant || null,
        quotedRemoteJid: contextInfo?.remoteJid || null,
      },
      key: messageKeySnapshot(msg),
    },
    handler: { upsertType },
    groqCalls: [],
  });
}

function recordPreparedTrace(traceId, prepared) {
  mutateDebugTrace(traceId, (trace) => {
    trace.status = "parsed";
    trace.chat = {
      ...(trace.chat || {}),
      id: prepared.chatId,
      isGroup: prepared.isGroup,
      groupName: prepared.groupName,
    };
    trace.sender = {
      ...(trace.sender || {}),
      senderAliases: prepared.senderAliases,
      canonicalPerson: prepared.person ? {
        id: prepared.person.id || null,
        displayName: prepared.person.displayName || null,
        aliases: prepared.person.aliases || [],
        seenChats: prepared.person.seenChats || [],
      } : null,
    };
    trace.whatsapp = {
      ...(trace.whatsapp || {}),
      rawText: prepared.rawText,
      userVisibleEstimate: prepared.userVisibleEstimate,
      messageType: prepared.messageType,
      contextInfo: {
        ...(trace.whatsapp?.contextInfo || {}),
        mentionedJid: prepared.mentionedJids,
      },
    };
    trace.parsing = {
      botAliases: prepared.botAliases,
      mentionSteps: prepared.mentionSteps,
      expectedSanitizedText: prepared.sanitizedText,
      actualSanitizedText: prepared.sanitizedText,
      sanitizerMatchedExpectation: true,
      identityPrompt: prepared.identityPrompt || null,
      implementation: "explicit message-handler pipeline",
    };
  });
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

async function learnConversationNames(msg, from, isGroup, senderName, prepared) {
  if (!isGroup) {
    if (senderName !== "there") await saveName(from, senderName);
    return { userId: null, groupName: null };
  }

  const groupName = prepared?.groupName || null;
  if (groupName) await saveName(from, groupName);

  const participant = msg.key.participantPn || msg.key.participantLid ||
    msg.key.participantAlt || msg.key.participant;
  const userId = normalizeJid(participant);
  if (userId) await saveGroupMember(from, userId, senderName, prepared?.person || null);
  return { userId, groupName };
}

async function canonicalPersonId(prepared, fallbackIdentifier) {
  if (prepared?.person?.id) return prepared.person.id;
  if (!fallbackIdentifier) return null;
  try {
    const identity = await resolveIdentity(fallbackIdentifier, prepared?.person || null);
    return identity.id || null;
  } catch {
    return null;
  }
}

async function maybeSendMoodSticker(sock, from, mood) {
  const allowed = await isStickerEnabled(from);
  if (!allowed || Math.random() >= 0.25) return null;

  try {
    const sticker = await getRandomSticker(mood);
    if (sticker?.base64) {
      await sock.sendMessage(from, { sticker: Buffer.from(sticker.base64, "base64") });
      return sticker.id || true;
    }
  } catch (error) {
    console.error("[sticker] Failed to send:", error.message);
  }

  return null;
}

async function handleAI(sock, msg, { traceId, prepared }) {
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  const senderName = getSenderName(msg);
  const text = prepared?.sanitizedText || getMessageText(msg);
  const startedAt = Date.now();
  const { userId, groupName } = await learnConversationNames(
    msg,
    from,
    isGroup,
    senderName,
    prepared
  );
  const personId = await canonicalPersonId(prepared, userId || from);

  mutateDebugTrace(traceId, (trace) => {
    trace.status = "processing";
    trace.chat = { ...(trace.chat || {}), id: from, isGroup, groupName };
    trace.sender = {
      ...(trace.sender || {}),
      displayNameUsed: senderName,
      normalizedUserId: userId,
      canonicalPersonId: personId,
    };
    trace.handler = {
      ...(trace.handler || {}),
      textReadByHandler: text,
      startedAt,
    };
    if (trace.parsing) {
      trace.parsing.actualSanitizedText = text;
      trace.parsing.sanitizerMatchedExpectation = text === trace.parsing.expectedSanitizedText;
    }
  });

  try {
    await sock.sendPresenceUpdate("composing", from);

    const relationshipBefore = personId ? await loadRelationship(personId) : null;
    const systemDecision = await evaluateSystemDecision({
      chatId: from,
      text,
      name: senderName,
      relationship: relationshipBefore,
      traceId,
    });
    const mood = systemDecision.mood;

    const relationshipResult = personId
      ? await applyRelationshipDecision(personId, systemDecision.relationship)
      : { state: relationshipBefore, transition: null, applied: false, evaluation: null };
    const relationship = relationshipResult.state || relationshipBefore;

    mutateDebugTrace(traceId, (trace) => {
      trace.relationship = {
        personId,
        before: publicRelationship(relationshipBefore),
        decision: systemDecision.relationship,
        evaluation: relationshipResult.evaluation || null,
        transition: relationshipResult.transition || null,
        after: publicRelationship(relationship),
      };
    });

    if (relationshipResult.transition) {
      console.log(
        `[relationship] ${senderName}: ${relationshipResult.transition.from} → ${relationshipResult.transition.to}`
      );
      addToFeed({
        type: "system",
        message: `${senderName} relationship changed: ${relationshipResult.transition.from} → ${relationshipResult.transition.to}`,
      });
    }

    await saveMood(from, mood);
    if (isGroup && userId) await saveMood(`${from}:${userId}`, mood);

    const reply = await getAIReply(
      from,
      text,
      senderName,
      mood,
      relationship,
      traceId,
      prepared?.identityPrompt || null
    );
    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    const stickerSent = await maybeSendMoodSticker(sock, from, mood);

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
      relationship: relationship?.status || null,
      responseTime,
    });

    updateDebugTrace(traceId, {
      status: "completed",
      completedAt: Date.now(),
      delivery: {
        replyText: reply,
        quotedMessage: true,
        sentToWhatsApp: true,
        stickerSent,
        responseTimeMs: responseTime,
      },
    });

    if (stats.totalMessages % 10 === 0) await saveStats();
  } catch (error) {
    console.error("Reply error:", error);
    updateDebugTrace(traceId, {
      status: "error",
      completedAt: Date.now(),
      error: safeError(error),
    });
    await sock.sendMessage(from, { text: "Oops 😅 AI couldn't respond right now." }, { quoted: msg });
  } finally {
    await sock.sendPresenceUpdate("paused", from).catch(() => {});
  }
}

async function onMessage(sock, botJid, botLid, { messages, type }) {
  if (type !== "notify" && type !== "append") return;

  for (const msg of messages) {
    if (!msg?.message || msg.key?.fromMe || msg.key?.remoteJid === "status@broadcast") continue;

    const traceId = createIncomingTrace(msg, type);
    let prepared;

    try {
      prepared = await prepareIncomingMessage(sock, msg);
      recordPreparedTrace(traceId, prepared);
    } catch (error) {
      noteDebugPreprocessError(error);
      const emergency = emergencySanitize(msg);
      prepared = {
        ...emergency,
        userVisibleEstimate: emergency.rawText,
        contextInfo: getContextInfo(msg),
        mentionedJids: [],
        mentionSteps: [],
        botAliases: [],
        senderAliases: [],
        person: null,
        identityPrompt: null,
        groupName: null,
        isGroup: Boolean(msg.key.remoteJid?.endsWith("@g.us")),
        chatId: msg.key.remoteJid,
      };
      updateDebugTrace(traceId, {
        status: "preprocess-error",
        error: safeError(error),
        parsing: {
          expectedSanitizedText: emergency.sanitizedText,
          actualSanitizedText: emergency.sanitizedText,
          sanitizerMatchedExpectation: true,
          mentionSteps: [],
          implementation: "emergency numeric-mention scrub",
        },
      });
    }

    if (runtime.botPaused) {
      markSkipped(traceId, "Bot is paused");
      continue;
    }

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");

    if (runtime.stickerCaptureMode && msg.message.stickerMessage) {
      try {
        await captureSticker(msg, from);
        updateDebugTrace(traceId, { status: "sticker-captured", completedAt: Date.now() });
      } catch (error) {
        console.error("[sticker] Failed to capture:", error.message);
        updateDebugTrace(traceId, {
          status: "error",
          error: safeError(error),
          completedAt: Date.now(),
        });
      }
      continue;
    }

    const text = prepared.sanitizedText.trim();
    mutateDebugTrace(traceId, (trace) => {
      trace.handler = {
        ...(trace.handler || {}),
        textAtFilterStage: text,
        botJid,
        botLid,
      };
    });

    if (!text) {
      markSkipped(traceId, "Parsed text was empty");
      continue;
    }
    if (text.length > 400) {
      markSkipped(traceId, "Message exceeded 400 characters", { length: text.length });
      continue;
    }

    const addressedToBot = !isGroup || isBotMentionedOrReplied(msg, botJid, botLid);
    mutateDebugTrace(traceId, (trace) => {
      trace.handler = { ...(trace.handler || {}), addressedToBot };
    });
    if (!addressedToBot) {
      markSkipped(traceId, "Group message did not mention or reply to Aveline");
      continue;
    }

    if (await isBlacklisted(from)) {
      console.log(`[blacklist] Ignored message from ${from}`);
      markSkipped(traceId, "Chat is blacklisted");
      continue;
    }

    if (isGroup) {
      const participant = msg.key.participantPn || msg.key.participantLid ||
        msg.key.participantAlt || msg.key.participant;
      const userId = normalizeJid(participant);
      if (userId && await isBlacklisted(userId)) {
        console.log(`[blacklist] Ignored group message from member ${userId}`);
        markSkipped(traceId, "Sender is blacklisted", { userId });
        continue;
      }
    }

    console.log(`[msg] ${from} | ${msg.pushName}: ${text}`);
    await handleAI(sock, msg, { traceId, prepared });
  }
}

module.exports = { onMessage, handleAI };
