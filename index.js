const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const express = require("express");
const QRCode = require("qrcode");

const app = express();
let lastQR = null;
let botStatus = "waiting for QR...";
const AUTH_PATH = process.env.RAILWAY_ENVIRONMENT ? "/app/auth" : "./auth";

app.get("/", async (req, res) => {
  if (!lastQR) {
    return res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>${botStatus}</h2></body></html>`);
  }
  const qrImage = await QRCode.toDataURL(lastQR);
  res.send(`<html><body style="background:#111;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:16px"><h2>Scan with WhatsApp</h2><img src="${qrImage}" style="width:280px;height:280px;border-radius:12px"/><p style="color:#aaa;font-size:14px">Refresh if expired</p></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[web] QR page running on port ${PORT}`));

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
    if (botLid && cleanJid === botLid.replace(/:\d+/, "")) return true;
    // match by number portion only
    if (cleanJid.split("@")[0] === botNumber) return true;
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

async function onMessage(sock, botJid, { messages, type }) {
  if (type !== "notify") return;
  for (const msg of messages) {
    if (msg.key.fromMe) continue;
    if (msg.key.remoteJid === "status@broadcast") continue;

    const isGroup = msg.key.remoteJid.endsWith("@g.us") || msg.key.remoteJid.endsWith("@lid");

    if (isGroup) {
      // try to get botLid from group metadata
      let botLid = sock.user?.lid || null;
      try {
        const meta = await sock.groupMetadata(msg.key.remoteJid);
        const me = meta.participants.find(p =>
          p.id.replace(/:\d+/, "").split("@")[0] === botJid.replace(/:\d+/, "").split("@")[0]
        );
        if (me) botLid = me.lid || me.id;
      } catch (_) {}

      console.log("[debug] botJid:", botJid, "| botLid:", botLid);
      console.log("[debug] mentioned:", msg.message?.extendedTextMessage?.contextInfo?.mentionedJid);

      if (!isBotMentioned(msg, botJid, botLid)) continue;
    }

    const text = getMessageText(msg).toLowerCase().trim();
    console.log(`[msg] from=${msg.pushName} | text="${text}"`);
    await handleGreeting(sock, msg);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      lastQR = qr;
      console.log("[qr] New QR generated — open your Railway URL to scan");
    }
    if (connection === "close") {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log(shouldReconnect ? "[connection] reconnecting…" : "[connection] logged out.");
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      lastQR = null;
      botStatus = "✅ Bot is online!";
      console.log("[connection] ✅ Bot is online!");
      console.log("[connection] botJid:", sock.user?.id);
    }
  });

  sock.ev.on("messages.upsert", async (upsert) => {
    const botJid = sock.user?.id;
    if (!botJid) return;
    try {
      await onMessage(sock, botJid, upsert);
    } catch (err) {
      console.error("[error]", err);
    }
  });
}

startBot();
