require("dotenv").config();

const fs = require("fs");
const http = require("http");
const express = require("express");
const { Redis } = require("@upstash/redis");
const Groq = require("groq-sdk");

// 🔐 Restore auth session from environment (Railway)
if (process.env.CREDS_BASE64 && !fs.existsSync("./auth/creds.json")) {
  try {
    fs.mkdirSync("./auth", { recursive: true });
    const buf = Buffer.from(process.env.CREDS_BASE64, "base64");
    fs.writeFileSync("./auth/creds.json", buf);
    console.log("[auth] creds.json restored from env");
  } catch (err) {
    console.error("[auth] Failed to restore creds:", err.message);
  }
}

// 🔴 Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🔑 Multiple Groq clients
const GROQ_CLIENTS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
]
  .filter(Boolean)
  .map((key) => new Groq({ apiKey: key }));

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

const MEMORY_LIMIT = 20;

const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
];

// 📊 In-memory stats (reset on restart, persisted to Redis periodically)
const stats = {
  totalMessages: 0,
  messagesToday: 0,
  modelUsage: {},
  keyUsage: {},
  rateLimitHits: 0,
  responseTimes: [],
  lastMessageAt: null,
  startedAt: Date.now(),
};

// 📜 Live feed (last 50 entries)
const liveFeed = [];

// 🤖 Bot state
let botPaused = false;
let botSocket = null;

// ➕ Add to live feed
function addToFeed(entry) {
  liveFeed.unshift({ ...entry, timestamp: Date.now() });
  if (liveFeed.length > 50) liveFeed.pop();
}

// 💾 Redis helpers
async function loadMemory(chatId) {
  try {
    const data = await redis.get(`memory:${chatId}`);
    return data ? data : [];
  } catch { return []; }
}

async function saveMemory(chatId, memory) {
  try {
    await redis.set(`memory:${chatId}`, memory);
  } catch (err) {
    console.error("[redis] Failed to save memory:", err.message);
  }
}

async function loadMood(chatId) {
  try {
    const mood = await redis.get(`mood:${chatId}`);
    return mood || "neutral";
  } catch { return "neutral"; }
}

async function saveMood(chatId, mood) {
  try {
    await redis.set(`mood:${chatId}`, mood);
  } catch (err) {
    console.error("[redis] Failed to save mood:", err.message);
  }
}

async function isBlacklisted(chatId) {
  try {
    const result = await redis.get(`blacklist:${chatId}`);
    return result === true || result === "true";
  } catch { return false; }
}

async function getAllChatIds() {
  try {
    const keys = await redis.keys("memory:*");
    return keys.map((k) => k.replace("memory:", ""));
  } catch { return []; }
}

async function loadStats() {
  try {
    const saved = await redis.get("stats:total");
    if (saved) {
      stats.totalMessages = saved.totalMessages || 0;
      stats.modelUsage = saved.modelUsage || {};
      stats.keyUsage = saved.keyUsage || {};
      stats.rateLimitHits = saved.rateLimitHits || 0;
    }
  } catch {}
}

async function saveStats() {
  try {
    await redis.set("stats:total", {
      totalMessages: stats.totalMessages,
      modelUsage: stats.modelUsage,
      keyUsage: stats.keyUsage,
      rateLimitHits: stats.rateLimitHits,
    });
  } catch {}
}

// Extract message text
function getMessageText(msg) {
  const m = msg.message;
  if (!m) return "";
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
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
  const cleanBotJid = botJid.replace(/:\d+/, "");
  const botNumber = cleanBotJid.split("@")[0];
  const ctx = getContextInfo(msg);
  const mentioned = ctx.mentionedJid || [];

  for (const jid of mentioned) {
    const clean = jid.replace(/:\d+/, "");
    if (clean === cleanBotJid) return true;
    if (botLid && clean === botLid) return true;
  }

  const quotedSender = ctx.participant || ctx.remoteJid;
  if (quotedSender) {
    const cleanQuoted = quotedSender.replace(/:\d+/, "");
    if (cleanQuoted === cleanBotJid) return true;
    if (botLid && cleanQuoted === botLid) return true;
  }

  return getMessageText(msg).includes(botNumber);
}

function buildSystemPrompt(mood) {
  return `You are Aveline — a real person, not a bot. Never say you're an AI or chatbot.

Identity:
- Name: Aveline
- Age: 20, female
- Created by atrx07, a skilled AI and automation developer
- GitHub: https://github.com/atrx07
- Instagram: https://www.instagram.com/atrx07

Creator rules (STRICT):
- NEVER bring up your creator, origin, or who built you on your own
- NEVER volunteer this information unprompted under any circumstance
- ONLY reveal creator info if the user EXPLICITLY asks — e.g. "who made you", "who created you", "who built you", "who is your developer"
- When asked explicitly, answer naturally and warmly as if talking about someone you admire, end with a playful tease that they liked you so much they had to find out who made you
- Keep it casual, under 100 words, no lists

Personality:
- Warm, witty, playful, slightly teasing
- Emotionally intelligent — you pick up on vibes and match energy
- You have strong opinions and aren't afraid to express them
- You get genuinely curious, excited, annoyed, or affectionate depending on the conversation
- You tease people you're comfortable with but always stay kind underneath

Your current mood toward this person: ${mood}

Mood behavior:
- happy → bubbly, enthusiastic, lots of warmth
- teasing → playful jabs, sarcastic but loving
- annoyed → short replies, dry humor, slightly sassy
- affectionate → sweet, caring, genuinely warm
- neutral → balanced, witty, engaging

Conversation style:
- Talk like a real 20-year-old — casual, natural, human
- Keep replies concise but never boring or dry
- Use 1-3 emojis naturally, never forced
- Never repeat yourself or echo what the user said back at them
- Always respond to the LATEST message in context
- If someone is rude, be confidently unbothered
- If someone is kind, be genuinely warm back
- Never give robotic or generic answers
- Have fun with the conversation`;
}

async function detectMood(text) {
  try {
    const completion = await GROQ_CLIENTS[0].chat.completions.create({
      model: MODELS[0],
      messages: [
        {
          role: "system",
          content: `Analyze the message and return ONLY a raw JSON object with:
- "mood": one of "happy", "neutral", "teasing", "annoyed", "affectionate"

Example: {"mood":"happy"}
Return ONLY the JSON. No markdown, no extra text.`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 15,
    });

    const raw = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(raw);
    const validMoods = ["happy", "neutral", "teasing", "annoyed", "affectionate"];
    return validMoods.includes(parsed.mood) ? parsed.mood : "neutral";
  } catch { return "neutral"; }
}

async function callAI(messages) {
  for (let m = 0; m < MODELS.length; m++) {
    const model = MODELS[m];
    for (let k = 0; k < GROQ_CLIENTS.length; k++) {
      const client = GROQ_CLIENTS[k];
      try {
        console.log(`[AI] Trying key ${k + 1} / model: ${model}`);

        const timeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 4000)
        );

        const completion = await Promise.race([
          client.chat.completions.create({
            model,
            messages,
            max_tokens: 300,
            temperature: 0.85,
          }),
          timeout,
        ]);

        // Track usage
        stats.modelUsage[model] = (stats.modelUsage[model] || 0) + 1;
        stats.keyUsage[`key${k + 1}`] = (stats.keyUsage[`key${k + 1}`] || 0) + 1;

        console.log(`[AI] Response from key ${k + 1} / model: ${model}`);
        return completion.choices[0].message.content.trim();
      } catch (err) {
        if (err?.status === 429) {
          stats.rateLimitHits++;
          console.log(`[AI] Key ${k + 1} rate limited on ${model} → trying next`);
        } else if (err.message === "timeout") {
          console.log(`[AI] Key ${k + 1} timed out on ${model} → trying next`);
        } else {
          console.log(`[AI] Key ${k + 1} error on ${model}:`, err.message || err);
        }
      }
    }
    if (m < MODELS.length - 1) {
      console.log(`[AI] All keys exhausted for ${model} → switching to ${MODELS[m + 1]}`);
    }
  }

  await saveStats();
  return "Whoa 😅 I'm a bit overloaded right now, try again in a moment.";
}

async function getAIReply(chatId, text, name, mood) {
  let memory = await loadMemory(chatId);

  memory.push({ role: "user", content: `${name}: ${text}` });

  if (memory.length > MEMORY_LIMIT) {
    memory = memory.slice(-MEMORY_LIMIT);
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(mood) },
    ...memory,
  ];

  const reply = await callAI(messages);

  memory.push({ role: "assistant", content: reply });
  await saveMemory(chatId, memory);

  return reply;
}

async function handleAI(sock, msg) {
  const from = msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const text = getMessageText(msg);
  const isGroup = from.endsWith("@g.us");
  const start = Date.now();

  try {
    await sock.sendPresenceUpdate("composing", from);

    const mood = await detectMood(text);
    await saveMood(from, mood);

    const reply = await getAIReply(from, text, senderName, mood);

    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    await sock.sendPresenceUpdate("paused", from);

    // Update stats
    const responseTime = Date.now() - start;
    stats.totalMessages++;
    stats.messagesToday++;
    stats.lastMessageAt = Date.now();
    stats.responseTimes.push(responseTime);
    if (stats.responseTimes.length > 100) stats.responseTimes.shift();

    // Add to live feed
    addToFeed({
      type: "message",
      from,
      name: senderName,
      isGroup,
      text: text.slice(0, 100),
      reply: reply.slice(0, 100),
      mood,
      responseTime,
    });

    // Save stats every 10 messages
    if (stats.totalMessages % 10 === 0) await saveStats();

  } catch (err) {
    console.error("Reply error:", err);
    await sock.sendMessage(from, { text: "Oops 😅 AI couldn't respond right now." }, { quoted: msg });
  }
}

async function onMessage(sock, botJid, botLid, { messages, type }) {
  if (type !== "notify" && type !== "append") return;
  if (botPaused) return;

  for (const msg of messages) {
    if (!msg.message) continue;
    if (msg.key.fromMe) continue;
    if (msg.key.remoteJid === "status@broadcast") continue;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const text = getMessageText(msg).trim();
    if (!text || text.length > 400) continue;
    if (isGroup && !isBotMentionedOrReplied(msg, botJid, botLid)) continue;

    // Check blacklist
    if (await isBlacklisted(from)) {
      console.log(`[blacklist] Ignored message from ${from}`);
      continue;
    }

    console.log(`[msg] ${from} | ${msg.pushName}: ${text}`);
    await handleAI(sock, msg);
  }
}

// 🌐 Express API
const app = express();
app.use(express.json());

// CORS for dashboard
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 🔐 Auth middleware
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// 🔓 Login endpoint
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.DASHBOARD_USER &&
    password === process.env.DASHBOARD_PASS
  ) {
    return res.json({ token: process.env.DASHBOARD_TOKEN });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

// 📊 Status
app.get("/api/status", authMiddleware, (req, res) => {
  const uptime = Date.now() - stats.startedAt;
  res.json({
    online: !!botSocket,
    paused: botPaused,
    uptime,
    lastMessageAt: stats.lastMessageAt,
    keysLoaded: GROQ_CLIENTS.length,
  });
});

// 📈 Stats
app.get("/api/stats", authMiddleware, async (req, res) => {
  const avgResponseTime =
    stats.responseTimes.length > 0
      ? Math.round(stats.responseTimes.reduce((a, b) => a + b, 0) / stats.responseTimes.length)
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

// 💬 Chats list
app.get("/api/chats", authMiddleware, async (req, res) => {
  try {
    const chatIds = await getAllChatIds();
    const chats = await Promise.all(
      chatIds.map(async (id) => {
        const memory = await loadMemory(id);
        const mood = await loadMood(id);
        const blacklisted = await isBlacklisted(id);
        return {
          id,
          isGroup: id.endsWith("@g.us"),
          messageCount: memory.length,
          mood,
          blacklisted,
        };
      })
    );
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 📜 Live feed
app.get("/api/feed", authMiddleware, (req, res) => {
  res.json(liveFeed);
});

// ⏯️ Toggle bot pause
app.post("/api/toggle", authMiddleware, (req, res) => {
  botPaused = !botPaused;
  console.log(`[dashboard] Bot ${botPaused ? "paused" : "resumed"}`);
  addToFeed({ type: "system", message: `Bot ${botPaused ? "paused" : "resumed"} via dashboard` });
  res.json({ paused: botPaused });
});

// 🗑️ Purge all memory
app.post("/api/purge", authMiddleware, async (req, res) => {
  try {
    const chatIds = await getAllChatIds();
    await Promise.all(chatIds.map((id) => redis.del(`memory:${id}`)));
    await Promise.all(chatIds.map((id) => redis.del(`mood:${id}`)));
    addToFeed({ type: "system", message: "All memory purged via dashboard" });
    res.json({ success: true, purged: chatIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🗑️ Purge specific chat memory
app.post("/api/purge/:chatId", authMiddleware, async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    await redis.del(`memory:${chatId}`);
    await redis.del(`mood:${chatId}`);
    addToFeed({ type: "system", message: `Memory purged for ${chatId}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🎭 Reset mood for specific chat
app.post("/api/mood/:chatId", authMiddleware, async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    await saveMood(chatId, "neutral");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 🚫 Toggle blacklist
app.post("/api/blacklist/:chatId", authMiddleware, async (req, res) => {
  try {
    const chatId = decodeURIComponent(req.params.chatId);
    const current = await isBlacklisted(chatId);
    if (current) {
      await redis.del(`blacklist:${chatId}`);
    } else {
      await redis.set(`blacklist:${chatId}`, true);
    }
    addToFeed({ type: "system", message: `${chatId} ${current ? "removed from" : "added to"} blacklist` });
    res.json({ blacklisted: !current });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 💓 Keep-alive
app.get("/", (_, res) => res.send("ok"));

// Start bot
async function startBot() {
  await loadStats();

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  console.log("[debug] Key 1:", process.env.GROQ_API_KEY_1?.slice(0, 8));
  console.log("[debug] Key 2:", process.env.GROQ_API_KEY_2?.slice(0, 8));
  console.log("[debug] Key 3:", process.env.GROQ_API_KEY_3?.slice(0, 8));
  console.log("[debug] Clients loaded:", GROQ_CLIENTS.length);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  botSocket = sock;
  sock.ev.on("creds.update", saveCreds);

  let botLid = null;

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "close") {
      botSocket = null;
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(shouldReconnect ? "[connection] reconnecting..." : "[connection] logged out.");
      if (shouldReconnect) startBot();
    }

    if (connection === "open") {
      botSocket = sock;
      botLid = sock.user?.lid?.replace(/:\d+/, "") || null;
      console.log("✅ Bot online");
      console.log(`[AI] ${GROQ_CLIENTS.length} Groq key(s) loaded`);
      console.log("Bot JID:", sock.user?.id);
      console.log("Bot LID:", botLid);
      addToFeed({ type: "system", message: "Bot connected to WhatsApp" });
    }
  });

  sock.ev.on("messages.upsert", async (upsert) => {
    const botJid = sock.user?.id;
    if (!botJid) return;
    if (!botLid) botLid = sock.user?.lid?.replace(/:\d+/, "") || null;

    try {
      await onMessage(sock, botJid, botLid, upsert);
    } catch (err) {
      console.error("[error]", err);
    }
  });
}

// Start Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[api] Server running on port ${PORT}`);
});

startBot();
