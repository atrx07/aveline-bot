const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");

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

function getSenderName(msg) {
  return msg.pushName || msg.key.participant?.split("@")[0] || "there";
}

function isBotMentioned(msg, botJid, botLid) {
  const cleanBotJid = botJid.replace(/:\d+/, "");
  const botNumber = cleanBotJid.split("@")[0];
  const mentioned =
    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

  for (const jid of mentioned) {
    const cleanJid = jid.replace(/:\d+/, "");
    if (cleanJid === cleanBotJid) return true;
    if (botLid && cleanJid === botLid) return true;
  }

  return getMessageText(msg).includes(botNumber);
}

async function handleGreeting(sock, msg) {
  const from = msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const greetings = [
    `Hey ${senderName}! 👋 What's up?`,
    `Heyy ${senderName}! 😄 You called?`,
    `Yo ${senderName}! 👀 What do you need?`,
    `Hello ${senderName}! 🙌 How can I help?`,
  ];
  const reply = greetings[Math.floor(Math.random() * greetings.length)];
  await sock.sendMessage(from, { text: reply }, { quoted: msg });
}

async function onMessage(sock, botJid, botLid, { messages, type }) {
  if (type !== "notify") return;
  for (const msg of messages) {
    if (msg.key.fromMe) continue;
    if (msg.key.remoteJid === "status@broadcast") continue;
    const isGroup = msg.key.remoteJid.endsWith("@g.us") || msg.key.remoteJid.endsWith("@lid");
    if (isGroup && !isBotMentioned(msg, botJid, botLid)) continue;
    const text = getMessageText(msg).toLowerCase().trim();
    console.log(`[msg] from=${msg.pushName} | text="${text}"`);
    await handleGreeting(sock, msg);
  }
}

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
      console.log(shouldReconnect ? "[connection] reconnecting…" : "[connection] logged out.");
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      // grab LID from account info if available
      botLid = sock.user?.lid?.replace(/:\d+/, "") || null;
      console.log("[connection] ✅ Bot is online!");
      console.log("[connection] botJid:", sock.user?.id);
      console.log("[connection] botLid:", botLid);
    }
  });

  sock.ev.on("messages.upsert", async (upsert) => {
    const botJid = sock.user?.id;
    if (!botJid) return;
    // fallback: extract lid from first group message if not set yet
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
