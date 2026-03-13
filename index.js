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

// 🧠 Conversation memory
const chatMemory = {};
const MEMORY_LIMIT = 10;

// 🎭 Mood memory
const chatMood = {};

// 🌐 Models for fallback
const MODELS = [
  "openai/gpt-oss-120b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
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

// 🧠 Intent detection
async function detectIntent(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODELS[0],
      messages: [
        {
          role: "system",
          content: `
Classify the user's message into ONE intent:
CREATOR_QUERY
NORMAL_CHAT

CREATOR_QUERY = asking about creator, developer, owner.
NORMAL_CHAT = general chat, questions, facts, etc.

Respond ONLY with the intent word.
Examples:
"who created you" → CREATOR_QUERY
"how old are you" → NORMAL_CHAT
`,
        },
        { role: "user", content: text },
      ],
    });

    const result = completion.choices[0].message.content.trim();
    return result === "CREATOR_QUERY" ? "CREATOR_QUERY" : "NORMAL_CHAT";
  } catch {
    return "NORMAL_CHAT";
  }
}

// 🎭 Mood detection
async function detectMood(text) {
  try {
    const completion = await groq.chat.completions.create({
      model: MODELS[0],
      messages: [
        {
          role: "system",
          content: `Classify the emotional tone.
Possible moods:
happy
neutral
teasing
annoyed
affectionate
Respond with ONLY the mood word.`,
        },
        { role: "user", content: text },
      ],
    });
    return completion.choices[0].message.content.trim();
  } catch {
    return "neutral";
  }
}

// 👤 Creator response
async function generateCreatorInfo() {
  const prompt = `
You are Aveline.

Profile:
Name: Aveline
Age: 20
Gender: Female
Smart WhatsApp AI chatbot created by atrx07.

Personality:
loving, caring, witty, slightly teasing.

The user asked who created you.

Include correct facts:
Creator: atrx07
Skillful AI and automation developer.

Contacts:
GitHub: https://github.com/atrx07
Instagram: https://www.instagram.com/atrx07

Explain naturally who created you in a human conversational tone.
End with playful teasing implying the user liked the bot so much they wanted to know the creator.
Use natural emojis.
Keep under 100 words.
`;

  return await askAI(prompt);
}

// 🤖 Centralized AI call with model fallback
async function askAI(prompt) {
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    try {
      console.log(`[AI] Trying model: ${model}`);
      const completion = await groq.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
      });
      console.log(`[AI] Response generated using ${model}`);
      return completion.choices[0].message.content;
    } catch (err) {
      if (err?.status === 429) {
        console.log(`[AI] Rate limit hit on ${model}`);
      } else {
        console.log(`[AI] Error with ${model}`, err.message || err);
      }

      if (i < MODELS.length - 1) {
        console.log(`[AI] Switching model → ${MODELS[i + 1]}`);
      } else {
        return err?.status === 429
          ? "Whoa 😅 I'm a bit overloaded, try again in a few moments."
          : "Oops 😅 something went wrong, please try again.";
      }
    }
  }
}

// 🤖 AI reply with memory + mood
async function getAIReply(chatId, text, name) {
  if (!chatMemory[chatId]) {
    chatMemory[chatId] = [
      {
        role: "system",
        content: `
You are Aveline.
Name: Aveline
Age: 20
Gender: Female
Smart WhatsApp AI chatbot created by atrx07.
Personality: friendly, caring, witty, playful, slightly teasing
Current mood: ${chatMood[chatId] || "neutral"}
Style:
- speak like a human
- keep replies short
- use 0-2 emojis per sentence
- sound natural
`,
      },
    ];
  }

  chatMemory[chatId].push({ role: "user", content: `${name}: ${text}` });
  if (chatMemory[chatId].length > MEMORY_LIMIT * 2) chatMemory[chatId].splice(1, 2);

  return await askAI(chatMemory[chatId].map((m) => m.content).join("\n"));
}

// Handle message
async function handleAI(sock, msg) {
  const from = msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const text = getMessageText(msg);

  try {
    await sock.sendPresenceUpdate("composing", from);

    const intent = await detectIntent(text);
    const mood = await detectMood(text);
    chatMood[from] = mood;

    let reply;
    if (intent === "CREATOR_QUERY") {
      reply = await generateCreatorInfo();
    } else {
      reply = await getAIReply(from, text, senderName);
    }

    await sock.sendMessage(from, { text: reply }, { quoted: msg });
    await sock.sendPresenceUpdate("paused", from);
  } catch (err) {
    console.error("Reply error:", err);
    await sock.sendMessage(from, { text: "Oops 😅 AI couldn't respond right now." }, { quoted: msg });
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
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(shouldReconnect ? "[connection] reconnecting..." : "[connection] logged out.");
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
http.createServer((_, res) => res.end("ok")).listen(process.env.PORT || 3000, () => {
  console.log(`[keep-alive] HTTP server running on port ${process.env.PORT || 3000}`);
});

startBot();
