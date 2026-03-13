require("dotenv").config();

const fs = require("fs");
const http = require("http");

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

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const Groq = require("groq-sdk");

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// 🧠 Conversation memory (proper role-based)
const chatMemory = {};
const MEMORY_LIMIT = 20;

// 🎭 Per-person mood memory
const chatMood = {};

// 🌐 Models for fallback
const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
];

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
function buildSystemPrompt(chatId) {
  const mood = chatMood[chatId] || "neutral";
  return `You are Aveline — a real person, not a bot. Never say you're an AI or chatbot.

Identity:
- Name: Aveline
- Age: 20, female
- Created by atrx07, a skilled developer

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

// 🧠🎭 Combined intent + mood detection in ONE API call
async function analyzeMessage(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODELS[0],
      messages: [
        {
          role: "system",
          content: `Analyze the message and return ONLY a raw JSON object with:
- "intent": "CREATOR_QUERY" (asking about creator/developer/owner/who made you) or "NORMAL_CHAT"
- "mood": one of "happy", "neutral", "teasing", "annoyed", "affectionate"

Example: {"intent":"NORMAL_CHAT","mood":"happy"}
Return ONLY the JSON. No markdown, no extra text.`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 20,
    });

    const raw = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(raw);
    const validMoods = ["happy", "neutral", "teasing", "annoyed", "affectionate"];
    return {
      intent: parsed.intent === "CREATOR_QUERY" ? "CREATOR_QUERY" : "NORMAL_CHAT",
      mood: validMoods.includes(parsed.mood) ? parsed.mood : "neutral",
    };
  } catch {
    return { intent: "NORMAL_CHAT", mood: "neutral" };
  }
}

// 👤 Creator response
async function generateCreatorInfo(chatId) {
  const messages = [
    { role: "system", content: buildSystemPrompt(chatId) },
    {
      role: "user",
      content: `The user asked who created you. Respond naturally and warmly.
Include: Creator is atrx07, a skilled AI and automation developer.
GitHub: https://github.com/atrx07
Instagram: https://www.instagram.com/atrx07
End with a playful tease that they liked you so much they had to know who made you.
Keep it under 100 words. Be natural, not formal.`,
    },
  ];

  return await callAI(messages);
}

// 🤖 Centralized AI call with model fallback
async function callAI(messages) {
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      console.log(`[AI] Trying model: ${model}`);
      const completion = await groq.chat.completions.create({
        model,
        messages,
        max_tokens: 300,
        temperature: 0.85,
      });
      console.log(`[AI] Response generated using ${model}`);
      return completion.choices[0].message.content.trim();
    } catch (err) {
      if (err?.status === 429) {
        console.log(`[AI] Rate limit hit on ${model}`);
      } else {
        console.log(`[AI] Error with ${model}:`, err.message || err);
      }

      if (i < MODELS.length - 1) {
        console.log(`[AI] Switching model → ${MODELS[i + 1]}`);
      } else {
        return err?.status === 429
          ? "Whoa 😅 I'm a bit overloaded, try again in a moment."
          : "Oops 😅 something went wrong, try again.";
      }
    }
  }
}

// 🤖 AI reply with proper role-based memory + per-person mood
async function getAIReply(chatId, text, name) {
  if (!chatMemory[chatId]) {
    chatMemory[chatId] = [];
  }

  chatMemory[chatId].push({
    role: "user",
    content: `${name}: ${text}`,
  });

  if (chatMemory[chatId].length > MEMORY_LIMIT) {
    chatMemory[chatId] = chatMemory[chatId].slice(-MEMORY_LIMIT);
  }

  // Fresh system prompt with this person's current mood
  const messages = [
    { role: "system", content: buildSystemPrompt(chatId) },
    ...chatMemory[chatId],
  ];

  const reply = await callAI(messages);

  chatMemory[chatId].push({
    role: "assistant",
    content: reply,
  });

  return reply;
}

// Handle message
async function handleAI(sock, msg) {
  const from = msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const text = getMessageText(msg);

  try {
    await sock.sendPresenceUpdate("composing", from);

    // Single API call for both intent and mood
    const { intent, mood } = await analyzeMessage(text);

    // Update this person's mood before generating reply
    chatMood[from] = mood;

    let reply;
    if (intent === "CREATOR_QUERY") {
      reply = await generateCreatorInfo(from);
    } else {
      reply = await getAIReply(from, text, senderName);
    }

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
