require("dotenv").config();

const fs = require("fs");
const http = require("http");
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

// 🔴 Redis client for persistent memory
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// 🔑 Multiple Groq clients — one per API key
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

// 🌐 Models for fallback
const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
];

// 💾 Load memory from Redis
async function loadMemory(chatId) {
  try {
    const data = await redis.get(`memory:${chatId}`);
    return data ? data : [];
  } catch {
    return [];
  }
}

// 💾 Save memory to Redis
async function saveMemory(chatId, memory) {
  try {
    await redis.set(`memory:${chatId}`, memory);
  } catch (err) {
    console.error("[redis] Failed to save memory:", err.message);
  }
}

// 💾 Load mood from Redis
async function loadMood(chatId) {
  try {
    const mood = await redis.get(`mood:${chatId}`);
    return mood || "neutral";
  } catch {
    return "neutral";
  }
}

// 💾 Save mood to Redis
async function saveMood(chatId, mood) {
  try {
    await redis.set(`mood:${chatId}`, mood);
  } catch (err) {
    console.error("[redis] Failed to save mood:", err.message);
  }
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

// Extract context info
function getContextInfo(msg) {
  return (
    msg.message?.extendedTextMessage?.contextInfo ||
    msg.message?.imageMessage?.contextInfo ||
    msg.message?.videoMessage?.contextInfo ||
    {}
  );
}

// Sender name
function getSenderName(msg) {
  return msg.pushName || msg.key.participant?.split("@")[0] || "there";
}

// Mention detection
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

// 🧠 Build Aveline system prompt dynamically with per-person mood
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

// 🎭 Mood detection
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
  } catch {
    return "neutral";
  }
}

// 🤖 Centralized AI call — key fallback first, then model fallback
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

        console.log(`[AI] Response from key ${k + 1} / model: ${model}`);
        return completion.choices[0].message.content.trim();
      } catch (err) {
        if (err?.status === 429 || err.message === "timeout") {
          console.log(`[AI] Key ${k + 1} failed on ${model} (${err.message || "rate limit"}) → trying next`);
        } else {
          console.log(`[AI] Key ${k + 1} error on ${model}:`, err.message || err);
        }
      }
    }
    // All keys exhausted for this model, try next model
    if (m < MODELS.length - 1) {
      console.log(`[AI] All keys exhausted for ${model} → switching to ${MODELS[m + 1]}`);
    }
  }

  return "Whoa 😅 I'm a bit overloaded right now, try again in a moment.";
}

// 🤖 AI reply with persistent memory + per-person mood
async function getAIReply(chatId, text, name, mood) {
  let memory = await loadMemory(chatId);

  memory.push({
    role: "user",
    content: `${name}: ${text}`,
  });

  if (memory.length > MEMORY_LIMIT) {
    memory = memory.slice(-MEMORY_LIMIT);
  }

  const messages = [
    { role: "system", content: buildSystemPrompt(mood) },
    ...memory,
  ];

  const reply = await callAI(messages);

  memory.push({
    role: "assistant",
    content: reply,
  });

  await saveMemory(chatId, memory);

  return reply;
}

// Handle message
async function handleAI(sock, msg) {
  const from = msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const text = getMessageText(msg);

  try {
    await sock.sendPresenceUpdate("composing", from);

    // Detect mood first then apply to reply
    const mood = await detectMood(text);
    await saveMood(from, mood);

    const reply = await getAIReply(from, text, senderName, mood);

    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    await sock.sendPresenceUpdate("paused", from);
  } catch (err) {
    console.error("Reply error:", err);
    await sock.sendMessage(
      from,
      { text: "Oops 😅 AI couldn't respond right now." },
      { quoted: msg }
    );
  }
}

// Message handler
async function onMessage(sock, botJid, botLid, { messages, type }) {
  if (type !== "notify" && type !== "append") return;

  for (const msg of messages) {
    if (!msg.message) continue;
    if (msg.key.fromMe) continue;
    if (msg.key.remoteJid === "status@broadcast") continue;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const text = getMessageText(msg).trim();
    if (!text || text.length > 400) continue;
    if (isGroup && !isBotMentionedOrReplied(msg, botJid, botLid)) continue;

    console.log(`[msg] ${from} | ${msg.pushName}: ${text}`);
    await handleAI(sock, msg);
  }
}

// Start bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  console.log("[debug] Key 1:", process.env.GROQ_API_KEY_1?.slice(0, 8));
  console.log("[debug] Key 2:", process.env.GROQ_API_KEY_2?.slice(0, 8));
  console.log("[debug] Key 3:", process.env.GROQ_API_KEY_3?.slice(0, 8));
  console.log("[debug] Clients loaded:", GROQ_CLIENTS.length);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  let botLid = null;

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(
        shouldReconnect
          ? "[connection] reconnecting..."
          : "[connection] logged out."
      );
      if (shouldReconnect) startBot();
    }

    if (connection === "open") {
      botLid = sock.user?.lid?.replace(/:\d+/, "") || null;
      console.log("✅ Bot online");
      console.log(`[AI] ${GROQ_CLIENTS.length} Groq key(s) loaded`);
      console.log("Bot JID:", sock.user?.id);
      console.log("Bot LID:", botLid);
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

// 💓 Keep-alive HTTP server (prevents Railway from sleeping)
http
  .createServer((_, res) => res.end("ok"))
  .listen(process.env.PORT || 3000, () => {
    console.log(
      `[keep-alive] HTTP server running on port ${process.env.PORT || 3000}`
    );
  });

startBot();
