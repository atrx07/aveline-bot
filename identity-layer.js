"use strict";

require("dotenv").config();
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { IdentityStore } = require("./identity-store");
const {
  createDebugTrace,
  updateDebugTrace,
  appendGroqCall,
  finishGroqCall,
} = require("./src/state");

const context = new AsyncLocalStorage();
const identities = new IdentityStore();
const groupLearning = new Map();
let groqClientCounter = 0;

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "Unknown error").slice(0, 2000),
    status: error?.status || null,
  };
}

function requestSnapshot(request) {
  return {
    model: request?.model || null,
    max_tokens: request?.max_tokens ?? null,
    temperature: request?.temperature ?? null,
    messages: Array.isArray(request?.messages)
      ? request.messages.map((message) => ({
          role: message?.role || null,
          content: typeof message?.content === "string"
            ? message.content.slice(0, 20000)
            : message?.content ?? null,
        }))
      : [],
  };
}

function inferGroqPurpose(request) {
  const system = request?.messages?.[0]?.content;
  if (typeof system === "string" && system.includes("Analyze the message and return ONLY")) {
    return "mood";
  }
  if (typeof system === "string" && system.includes("You are Aveline")) {
    return "reply";
  }
  return "other";
}

function installGroq() {
  const path = require.resolve("groq-sdk");
  const RealGroq = require(path);

  require.cache[path].exports = new Proxy(RealGroq, {
    construct(Target, args) {
      const client = new Target(...args);
      const clientNumber = ++groqClientCounter;
      const completions = client?.chat?.completions;
      if (!completions || typeof completions.create !== "function") return client;

      const create = completions.create.bind(completions);
      completions.create = async (request, ...rest) => {
        const store = context.getStore();
        const identityPrompt = store?.identityPrompt;
        const messages = request?.messages;
        let finalRequest = request;

        if (
          identityPrompt &&
          Array.isArray(messages) &&
          typeof messages[0]?.content === "string" &&
          messages[0].content.includes("You are Aveline")
        ) {
          const next = messages.map((message, index) => index === 0
            ? { ...message, content: `${message.content}\n\n${identityPrompt}` }
            : message);
          finalRequest = { ...request, messages: next };
        }

        const traceId = store?.traceId;
        const callId = crypto.randomUUID();
        const purpose = inferGroqPurpose(finalRequest);
        const startedAt = Date.now();

        if (traceId) {
          appendGroqCall(traceId, {
            id: callId,
            purpose,
            clientNumber,
            model: finalRequest?.model || null,
            startedAt,
            status: "pending",
            request: requestSnapshot(finalRequest),
          });
        }

        try {
          const completion = await create(finalRequest, ...rest);
          const output = completion?.choices?.[0]?.message?.content ?? null;
          if (traceId) {
            finishGroqCall(traceId, callId, {
              status: "success",
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
              output: typeof output === "string" ? output.slice(0, 20000) : output,
              finishReason: completion?.choices?.[0]?.finish_reason || null,
              usage: completion?.usage || null,
            });
          }
          return completion;
        } catch (error) {
          if (traceId) {
            finishGroqCall(traceId, callId, {
              status: "error",
              completedAt: Date.now(),
              durationMs: Date.now() - startedAt,
              error: safeError(error),
            });
          }
          throw error;
        }
      };

      return client;
    },
  });
}

function shouldLearnGroup(metadata, groupId) {
  if (!metadata || !groupId || !Array.isArray(metadata.participants)) return false;
  const raw = metadata.participants.flatMap((participant) => identities.aliasesFrom(participant))
    .sort()
    .join("|");
  const signature = crypto.createHash("sha1").update(raw).digest("hex");
  const previous = groupLearning.get(groupId);
  const now = Date.now();

  if (previous?.signature === signature && now - previous.at < 21600000) return false;
  groupLearning.set(groupId, { signature, at: now });
  return true;
}

function replaceMentionTokens(text, steps, preserveBotName) {
  let result = text;
  for (const step of steps) {
    const token = step.rawToken.slice(1);
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const replacement = step.isBot
      ? (preserveBotName ? "@Aveline" : "")
      : step.replacement;
    result = result.replace(new RegExp(`@${escaped}(?!\\d)`, "g"), () => replacement);
  }
  return result.replace(/\s+/g, " ").replace(/\s+([?!.,;:])/g, "$1").trim();
}

async function buildDebugSeed(sock, msg, rawText, store) {
  const chatId = msg?.key?.remoteJid || null;
  const contextInfo = identities.contextInfo(msg);
  const mentionedJids = identities.unique(contextInfo?.mentionedJid || []);
  const botAliases = identities.botAliases(sock);
  const botAliasSet = new Set(botAliases);
  const steps = [];

  for (const jid of mentionedJids) {
    const resolvedName = await identities.mentionName(jid, chatId);
    const isBot = botAliasSet.has(jid);
    steps.push({
      jid,
      rawToken: `@${jid.split("@")[0]}`,
      isBot,
      resolvedName: isBot ? "Aveline" : (resolvedName || null),
      action: isBot ? "remove bot trigger" : (resolvedName ? "replace with display name" : "replace with safe fallback"),
      replacement: isBot ? "" : `@${resolvedName || "someone"}`,
    });
  }

  const parsedText = identities.text(msg).trim();
  const visibleEstimate = replaceMentionTokens(rawText, steps, true) || rawText;
  const expectedSanitized = replaceMentionTokens(rawText, steps, false)
    || "[The user mentioned Aveline to get her attention.]";

  return {
    status: "parsed",
    messageId: msg?.key?.id || null,
    chat: {
      id: chatId,
      isGroup: Boolean(chatId?.endsWith("@g.us")),
    },
    sender: {
      pushName: msg?.pushName || null,
      participant: msg?.key?.participant || null,
      participantAlt: msg?.key?.participantAlt || null,
      participantLid: msg?.key?.participantLid || null,
      participantPn: msg?.key?.participantPn || null,
      senderAliases: identities.senderAliases(msg),
      canonicalPerson: store?.person ? {
        id: store.person.id || null,
        displayName: store.person.displayName || null,
        aliases: store.person.aliases || [],
        seenChats: store.person.seenChats || [],
      } : null,
    },
    whatsapp: {
      messageType: Object.keys(msg?.message || {})[0] || "unknown",
      rawText,
      userVisibleEstimate: visibleEstimate,
      contextInfo: {
        mentionedJid: mentionedJids,
        quotedParticipant: contextInfo?.participant || null,
        quotedRemoteJid: contextInfo?.remoteJid || null,
      },
      key: {
        remoteJid: msg?.key?.remoteJid || null,
        remoteJidAlt: msg?.key?.remoteJidAlt || null,
        participant: msg?.key?.participant || null,
        participantAlt: msg?.key?.participantAlt || null,
        participantLid: msg?.key?.participantLid || null,
        participantPn: msg?.key?.participantPn || null,
        senderLid: msg?.key?.senderLid || null,
        senderPn: msg?.key?.senderPn || null,
      },
    },
    parsing: {
      botAliases,
      mentionSteps: steps,
      expectedSanitizedText: expectedSanitized,
      actualSanitizedText: parsedText,
      sanitizerMatchedExpectation: parsedText === expectedSanitized,
      identityPrompt: store?.identityPrompt || null,
    },
    groqCalls: [],
  };
}

function installBaileys() {
  const path = require.resolve("@whiskeysockets/baileys");
  const baileys = require(path);
  const makeSocket = baileys.makeWASocket;
  if (typeof makeSocket !== "function") throw new Error("Baileys makeWASocket export missing");

  baileys.makeWASocket = (...args) => {
    const sock = makeSocket(...args);
    const on = sock.ev.on.bind(sock.ev);
    const groupMetadata = sock.groupMetadata?.bind(sock);

    if (groupMetadata) {
      sock.groupMetadata = async (...metadataArgs) => {
        const metadata = await groupMetadata(...metadataArgs);
        const groupId = metadataArgs[0];
        const subject = identities.cleanName(metadata?.subject);
        if (groupId && subject) identities.chatNames.set(groupId, subject);
        if (shouldLearnGroup(metadata, groupId)) {
          identities.learnGroup(metadata, groupId)
            .catch((error) => console.error("[identity] Group learning failed:", error.message));
        }
        return metadata;
      };
    }

    on("contacts.upsert", (contacts) => identities.learnContacts(contacts).catch(() => {}));
    on("contacts.update", (contacts) => identities.learnContacts(contacts).catch(() => {}));
    on("messaging-history.set", (history) => identities.learnContacts(history?.contacts).catch(() => {}));
    on("chats.phoneNumberShare", (mapping) => identities.upsert({
      aliases: identities.aliasesFrom(mapping),
      presence: false,
    }).catch(() => {}));
    on("lid-mapping.update", (payload) => Promise.all(
      (Array.isArray(payload) ? payload : [payload]).map((entry) =>
        identities.upsert({ aliases: identities.aliasesFrom(entry), presence: false }))
    ).catch(() => {}));

    sock.ev.on = (event, listener) => event !== "messages.upsert"
      ? on(event, listener)
      : on(event, async (payload) => {
          for (const msg of Array.isArray(payload?.messages) ? payload.messages : []) {
            const rawText = identities.text(msg);
            let store = null;
            let traceId = null;

            try {
              store = await identities.preprocess(sock, msg);
              if (
                rawText &&
                !msg?.key?.fromMe &&
                msg?.key?.remoteJid !== "status@broadcast"
              ) {
                traceId = createDebugTrace(await buildDebugSeed(sock, msg, rawText, store));
                store.traceId = traceId;
                msg.__avelineTraceId = traceId;
              }
            } catch (error) {
              console.error("[identity] Message preprocessing failed:", error.message);
              if (rawText && !msg?.key?.fromMe) {
                traceId = createDebugTrace({
                  status: "preprocess-error",
                  messageId: msg?.key?.id || null,
                  whatsapp: { rawText },
                  error: safeError(error),
                  groqCalls: [],
                });
                msg.__avelineTraceId = traceId;
              }
            }

            const one = { ...payload, messages: [msg] };
            if (store) {
              await context.run(store, () => listener(one));
            } else {
              await listener(one);
            }

            if (traceId) {
              updateDebugTrace(traceId, { listenerCompletedAt: Date.now() });
            }
          }
        });

    return sock;
  };

  require.cache[path].exports = baileys;
}

try {
  installGroq();
  installBaileys();
  console.log("[identity] Canonical identity, mention resolver, and debug tracing enabled.");
} catch (error) {
  console.error("[identity] Failed to initialize identity layer:", error.message);
}
