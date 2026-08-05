"use strict";

require("dotenv").config();
const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { IdentityStore } = require("./identity-store");

const context = new AsyncLocalStorage();
const identities = new IdentityStore();
const groupLearning = new Map();

function installGroq() {
  const path = require.resolve("groq-sdk");
  const RealGroq = require(path);
  require.cache[path].exports = new Proxy(RealGroq, {
    construct(Target, args) {
      const client = new Target(...args);
      const completions = client?.chat?.completions;
      if (!completions || typeof completions.create !== "function") return client;
      const create = completions.create.bind(completions);
      completions.create = (request, ...rest) => {
        const prompt = context.getStore()?.identityPrompt;
        const messages = request?.messages;
        if (prompt && Array.isArray(messages) &&
          typeof messages[0]?.content === "string" && messages[0].content.includes("You are Aveline")) {
          const next = messages.map((message, index) => index === 0
            ? { ...message, content: `${message.content}\n\n${prompt}` } : message);
          return create({ ...request, messages: next }, ...rest);
        }
        return create(request, ...rest);
      };
      return client;
    },
  });
}

function shouldLearnGroup(metadata, groupId) {
  if (!metadata || !groupId || !Array.isArray(metadata.participants)) return false;
  const raw = metadata.participants.flatMap((p) => identities.aliasesFrom(p)).sort().join("|");
  const signature = crypto.createHash("sha1").update(raw).digest("hex");
  const previous = groupLearning.get(groupId);
  const now = Date.now();
  if (previous?.signature === signature && now - previous.at < 21600000) return false;
  groupLearning.set(groupId, { signature, at: now });
  return true;
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
        if (shouldLearnGroup(metadata, groupId)) identities.learnGroup(metadata, groupId)
          .catch((error) => console.error("[identity] Group learning failed:", error.message));
        return metadata;
      };
    }

    on("contacts.upsert", (contacts) => identities.learnContacts(contacts).catch(() => {}));
    on("contacts.update", (contacts) => identities.learnContacts(contacts).catch(() => {}));
    on("messaging-history.set", (history) => identities.learnContacts(history?.contacts).catch(() => {}));
    on("chats.phoneNumberShare", (mapping) => identities.upsert({
      aliases: identities.aliasesFrom(mapping), presence: false,
    }).catch(() => {}));
    on("lid-mapping.update", (payload) => Promise.all((Array.isArray(payload) ? payload : [payload])
      .map((entry) => identities.upsert({ aliases: identities.aliasesFrom(entry), presence: false }))).catch(() => {}));

    sock.ev.on = (event, listener) => event !== "messages.upsert" ? on(event, listener) :
      on(event, async (payload) => {
        for (const msg of Array.isArray(payload?.messages) ? payload.messages : []) {
          let store = null;
          try { store = await identities.preprocess(sock, msg); }
          catch (error) { console.error("[identity] Message preprocessing failed:", error.message); }
          const one = { ...payload, messages: [msg] };
          if (store) await context.run(store, () => listener(one));
          else await listener(one);
        }
      });
    return sock;
  };
  require.cache[path].exports = baileys;
}

try {
  installGroq();
  installBaileys();
  console.log("[identity] Canonical identity and mention resolver enabled.");
} catch (error) {
  console.error("[identity] Failed to initialize identity layer:", error.message);
}
