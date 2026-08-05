"use strict";

const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

class IdentityStore {
  constructor() {
    this.redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    this.aliasCache = new Map();
    this.personCache = new Map();
    this.contactNames = new Map();
    this.chatNames = new Map();
    this.presenceCache = new Set();
    this.schemaWritten = false;
  }

  normalize(value) {
    if (typeof value !== "string" || !value.includes("@")) return null;
    const [rawLocal, rawServer] = value.trim().split("@");
    if (!rawLocal || !rawServer) return null;
    const local = rawLocal.replace(/:\d+$/, "");
    const server = rawServer === "c.us" ? "s.whatsapp.net" : rawServer;
    const jid = `${local}@${server}`;
    return /@(?:s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;
  }

  unique(values) {
    return [...new Set((values || []).map((v) => this.normalize(v)).filter(Boolean))];
  }

  cleanName(value) {
    if (typeof value !== "string") return null;
    const name = value
      .replace(/[\x00-\x1F\x7F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^@+/, "");
    if (!name || name.length > 80) return null;
    if (/^(there|unknown|null|undefined)$/i.test(name)) return null;
    if (/^\+?\d{5,}$/.test(name)) return null;
    return name;
  }

  aliasesFrom(value) {
    if (!value || typeof value !== "object") return [];
    const fields = [
      "id", "jid", "lid", "pn", "phoneNumber", "participant",
      "participantAlt", "participantLid", "participantPn", "senderLid",
      "senderPn", "remoteJid", "remoteJidAlt",
    ];
    const values = fields.map((field) => value[field]);
    for (const [key, entry] of Object.entries(value)) {
      if (this.normalize(key)) values.push(key);
      if (typeof entry === "string" && this.normalize(entry)) values.push(entry);
    }
    return this.unique(values);
  }

  senderAliases(msg) {
    const group = msg?.key?.remoteJid?.endsWith("@g.us");
    const values = [
      msg?.key?.participant, msg?.key?.participantAlt,
      msg?.key?.participantLid, msg?.key?.participantPn,
      msg?.key?.senderLid, msg?.key?.senderPn, msg?.participant,
    ];
    if (!group) values.push(msg?.key?.remoteJid, msg?.key?.remoteJidAlt);
    return this.unique(values);
  }

  botAliases(sock) {
    return this.unique([sock?.user?.id, sock?.user?.jid, sock?.user?.lid, sock?.user?.phoneNumber]);
  }

  contextInfo(msg) {
    return msg?.message?.extendedTextMessage?.contextInfo ||
      msg?.message?.imageMessage?.contextInfo ||
      msg?.message?.videoMessage?.contextInfo || {};
  }

  text(msg) {
    const m = msg?.message;
    return m?.conversation || m?.extendedTextMessage?.text ||
      m?.imageMessage?.caption || m?.videoMessage?.caption || "";
  }

  setText(msg, text) {
    const m = msg?.message;
    if (!m) return;
    if (typeof m.conversation === "string") m.conversation = text;
    else if (typeof m.extendedTextMessage?.text === "string") m.extendedTextMessage.text = text;
    else if (typeof m.imageMessage?.caption === "string") m.imageMessage.caption = text;
    else if (typeof m.videoMessage?.caption === "string") m.videoMessage.caption = text;
  }

  async aliasPersonId(alias) {
    const jid = this.normalize(alias);
    if (!jid) return null;
    if (this.aliasCache.has(jid)) return this.aliasCache.get(jid);
    try {
      const id = await this.redis.get(`identity:alias:${jid}`);
      if (id) this.aliasCache.set(jid, id);
      return id || null;
    } catch { return null; }
  }

  async person(id) {
    if (!id) return null;
    if (this.personCache.has(id)) return this.personCache.get(id);
    try {
      const person = await this.redis.get(`identity:person:${id}`);
      if (person) this.personCache.set(id, person);
      return person || null;
    } catch { return null; }
  }

  mergeBy(items, key, limit) {
    const map = new Map();
    for (const item of (items || []).filter(Boolean)) {
      const id = key(item);
      if (!id) continue;
      const old = map.get(id);
      if (!old || (item.lastSeenAt || 0) >= (old.lastSeenAt || 0)) map.set(id, item);
    }
    return [...map.values()]
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .slice(0, limit);
  }

  async upsert({ aliases, name, source = "unknown", priority = 0,
    chatId = null, chatName = null, chatType = null, presence = true }) {
    aliases = this.unique(aliases);
    if (!aliases.length) return null;

    const existingIds = await Promise.all(aliases.map((alias) => this.aliasPersonId(alias)));
    const ids = [...new Set(existingIds.filter(Boolean))];
    const id = ids[0] || `person_${crypto.randomUUID()}`;
    const now = Date.now();
    let person = await this.person(id) || {
      id, schemaVersion: 1, aliases: [], names: [], seenChats: [],
      firstSeenAt: now, lastSeenAt: 0, displayName: null,
      displayNamePriority: 0, displayNameSource: null,
    };

    for (const duplicateId of ids.slice(1)) {
      const duplicate = await this.person(duplicateId);
      if (!duplicate) continue;
      person.aliases = this.unique([...person.aliases, ...(duplicate.aliases || [])]);
      person.names = this.mergeBy([...person.names, ...(duplicate.names || [])],
        (x) => `${x.source}:${x.value}`, 12);
      person.seenChats = this.mergeBy([...person.seenChats, ...(duplicate.seenChats || [])],
        (x) => x.chatId, 20);
      if ((duplicate.displayNamePriority || 0) > (person.displayNamePriority || 0)) {
        person.displayName = duplicate.displayName;
        person.displayNamePriority = duplicate.displayNamePriority;
        person.displayNameSource = duplicate.displayNameSource;
      }
    }

    const oldAliasCount = person.aliases.length;
    const oldName = person.displayName;
    const oldPriority = person.displayNamePriority || 0;
    const oldLastSeen = person.lastSeenAt || 0;
    const oldChats = new Map((person.seenChats || []).map((x) => [x.chatId, x]));

    person.aliases = this.unique([...person.aliases, ...aliases]).slice(0, 20);
    person.lastSeenAt = now;
    const cleanName = this.cleanName(name);
    if (cleanName) {
      person.names = this.mergeBy([
        ...(person.names || []),
        { value: cleanName, source, priority, lastSeenAt: now },
      ], (x) => `${x.source}:${x.value}`, 12);
      if (!person.displayName || priority >= oldPriority) {
        person.displayName = cleanName;
        person.displayNamePriority = priority;
        person.displayNameSource = source;
      }
    }

    let chatChanged = false;
    let chatWrite = null;
    if (presence && chatId) {
      const safeName = this.cleanName(chatName) || (chatType === "dm" ? "Direct message" : "Group chat");
      const previous = oldChats.get(chatId);
      chatChanged = !previous || previous.name !== safeName || previous.type !== chatType;
      person.seenChats = this.mergeBy([
        ...(person.seenChats || []),
        { chatId, name: safeName, type: chatType || "unknown", lastSeenAt: now },
      ], (x) => x.chatId, 20);
      const key = `${chatId}:${id}`;
      if (!this.presenceCache.has(key) || chatChanged) {
        this.presenceCache.add(key);
        chatWrite = this.redis.set(`identity:chat:${chatId}:${id}`, {
          personId: id, displayName: person.displayName, chatName: safeName,
          chatType: chatType || "unknown", lastSeenAt: now,
        }).catch(() => {});
      }
    }

    const writes = [];
    for (const alias of person.aliases) {
      const current = this.aliasCache.get(alias);
      this.aliasCache.set(alias, id);
      if (current !== id) writes.push(this.redis.set(`identity:alias:${alias}`, id).catch(() => {}));
    }

    const changed = !ids.length || ids.length > 1 || oldAliasCount !== person.aliases.length ||
      oldName !== person.displayName || oldPriority !== person.displayNamePriority ||
      chatChanged || now - oldLastSeen >= 300000;
    this.personCache.set(id, person);
    if (chatWrite) writes.push(chatWrite);
    if (changed) writes.push(this.redis.set(`identity:person:${id}`, person).catch((error) =>
      console.error("[identity] Failed to save person:", error.message)));
    if (!this.schemaWritten) {
      this.schemaWritten = true;
      writes.push(this.redis.set("identity:schema-version", 1).catch(() => { this.schemaWritten = false; }));
    }
    await Promise.all(writes);
    return person;
  }

  bestName(contact) {
    const options = [
      [contact?.name, "contactName", 100], [contact?.verifiedName, "verifiedName", 90],
      [contact?.username, "username", 80], [contact?.notify, "notify", 70],
      [contact?.pushName, "pushName", 60],
    ];
    for (const [value, source, priority] of options) {
      const name = this.cleanName(value);
      if (name) return { name, source, priority };
    }
    return null;
  }

  async learnContacts(contacts) {
    for (const contact of Array.isArray(contacts) ? contacts : []) {
      const aliases = this.aliasesFrom(contact);
      if (!aliases.length) continue;
      const found = this.bestName(contact);
      if (found) for (const alias of aliases) this.contactNames.set(alias, found);
      await this.upsert({ aliases, ...found, presence: false });
    }
  }

  async learnGroup(metadata, groupId) {
    const subject = this.cleanName(metadata?.subject);
    if (groupId && subject) this.chatNames.set(groupId, subject);
    for (const member of Array.isArray(metadata?.participants) ? metadata.participants : []) {
      const found = this.bestName(member);
      await this.upsert({ aliases: this.aliasesFrom(member), ...found, presence: false });
    }
  }

  async chatName(chatId, group) {
    if (!group) return "Direct message";
    if (this.chatNames.has(chatId)) return this.chatNames.get(chatId);
    try {
      const name = this.cleanName(await this.redis.get(`name:${chatId}`)) || "Group chat";
      this.chatNames.set(chatId, name);
      return name;
    } catch { return "Group chat"; }
  }

  async legacyName(chatId, aliases) {
    for (const alias of aliases) {
      const keys = chatId ? [`name:${chatId}:${alias}`, `name:${alias}`] : [`name:${alias}`];
      for (const key of keys) {
        try {
          const name = this.cleanName(await this.redis.get(key));
          if (name) return name;
        } catch {}
      }
    }
    return null;
  }

  async mentionName(alias, chatId) {
    const jid = this.normalize(alias);
    if (!jid) return null;
    const id = await this.aliasPersonId(jid);
    let person = await this.person(id);
    if (this.cleanName(person?.displayName)) return person.displayName;
    const aliases = this.unique([jid, ...(person?.aliases || [])]);
    const cached = this.contactNames.get(jid);
    const legacy = await this.legacyName(chatId, aliases);
    const found = cached || (legacy ? { name: legacy, source: "legacyName", priority: 50 } : null);
    person = await this.upsert({ aliases, ...found, chatId,
      chatType: chatId?.endsWith("@g.us") ? "group" : "dm" });
    return this.cleanName(person?.displayName);
  }

  async sanitize(sock, msg) {
    const mentions = this.unique(this.contextInfo(msg).mentionedJid || []);
    if (!mentions.length) return this.text(msg).trim();
    const own = new Set(this.botAliases(sock));
    let text = this.text(msg);
    for (const jid of mentions) {
      const token = jid.split("@")[0];
      const replacement = own.has(jid) ? "" : `@${await this.mentionName(jid, msg?.key?.remoteJid) || "someone"}`;
      const pattern = new RegExp(`@${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`, "g");
      text = text.replace(pattern, () => replacement);
    }
    text = text.replace(/@\d{5,}(?!\d)/g, "@someone")
      .replace(/\s+/g, " ").replace(/\s+([?!.,;:])/g, "$1").trim();
    if (!text) text = "[The user mentioned Aveline to get her attention.]";
    this.setText(msg, text);
    return text;
  }

  prompt(person, currentChatId) {
    const name = this.cleanName(person?.displayName);
    if (!name) return null;
    const chats = [...new Set((person.seenChats || [])
      .filter((x) => x.chatId && x.chatId !== currentChatId)
      .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      .slice(0, 5).map((x) => this.cleanName(x.name)).filter(Boolean))];
    const history = chats.length
      ? `You have encountered this same person in chats named: ${chats.map(JSON.stringify).join(", ")}.`
      : "This is the first chat context in which you have identified this person.";
    return [
      "Identity continuity:",
      `- The current speaker's display name is ${JSON.stringify(name)}.`,
      `- ${history}`,
      "- Recognize them naturally across chats when relevant, but do not force the topic.",
      "- Never expose internal IDs, phone numbers, alias mappings, or implementation details.",
      "- Never reveal or quote private messages from another chat. Identity may carry across chats; raw conversation content may not.",
    ].join("\n");
  }

  async preprocess(sock, msg) {
    const bot = this.botAliases(sock);
    if (bot.length) await this.upsert({ aliases: bot, name: "Aveline",
      source: "botIdentity", priority: 1000, presence: false });
    const chatId = msg?.key?.remoteJid || null;
    const group = chatId?.endsWith("@g.us");
    const person = await this.upsert({ aliases: this.senderAliases(msg), name: this.cleanName(msg?.pushName),
      source: "pushName", priority: 60, chatId,
      chatName: await this.chatName(chatId, group), chatType: group ? "group" : "dm" });
    await this.sanitize(sock, msg);
    if (person?.displayName) msg.pushName = person.displayName;
    return { person, currentChatId: chatId, identityPrompt: this.prompt(person, chatId) };
  }
}

module.exports = { IdentityStore };
