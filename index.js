require("dotenv").config();

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

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});


// 🧠 Conversation memory
const chatMemory = {};
const MEMORY_LIMIT = 10;


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


// Check mention or reply
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


// 🤖 AI reply with memory
async function getAIReply(chatId, text, name) {
  try {

    if (!chatMemory[chatId]) {
      chatMemory[chatId] = [
        {
          role: "system",
          content:
            "You are a friendly WhatsApp assistant. Keep replies casual, short and helpful.",
        },
      ];
    }

    chatMemory[chatId].push({
      role: "user",
      content: `${name}: ${text}`,
    });

    // limit memory
    if (chatMemory[chatId].length > MEMORY_LIMIT * 2) {
      chatMemory[chatId].splice(1, 2);
    }

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: chatMemory[chatId],
    });

    const reply = completion.choices[0].message.content;

    chatMemory[chatId].push({
      role: "assistant",
      content: reply,
    });

    return reply;

  } catch (err) {
    console.error("AI error:", err);
    return "Brain lag 😅 try again.";
  }
}


// Handle reply
async function handleAI(sock, msg) {
  const from = msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const text = getMessageText(msg);

  try {

    await sock.sendPresenceUpdate("composing", from);

    const aiReply = await getAIReply(from, text, senderName);

    await sock.sendMessage(
      from,
      { text: aiReply },
      { quoted: msg }
    );

    await sock.sendPresenceUpdate("paused", from);

  } catch (err) {
    console.error("reply error:", err);
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

    if (!text) continue;
    if (text.length > 400) continue;

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

    if (!botLid) {
      botLid = sock.user?.lid?.replace(/:\d+/, "") || null;
    }

    try {
      await onMessage(sock, botJid, botLid, upsert);
    } catch (err) {
      console.error("[error]", err);
    }

  });

}

startBot();
