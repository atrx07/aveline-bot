"use strict";

const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const { groqClients } = require("../config");
const { runtime, addToFeed } = require("../state");
const { onMessage } = require("./message-handler");

let reconnecting = false;

function normalizedBotLid(sock) {
  return sock.user?.lid?.replace(/:\d+/, "") || null;
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  console.log("[debug] Key 1:", process.env.GROQ_API_KEY_1?.slice(0, 8));
  console.log("[debug] Key 2:", process.env.GROQ_API_KEY_2?.slice(0, 8));
  console.log("[debug] Key 3:", process.env.GROQ_API_KEY_3?.slice(0, 8));
  console.log("[debug] Clients loaded:", groqClients.length);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  runtime.botSocket = sock;
  let botLid = normalizedBotLid(sock);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "close") {
      runtime.botSocket = null;
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(shouldReconnect ? "[connection] reconnecting..." : "[connection] logged out.");

      if (shouldReconnect && !reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          startBot()
            .catch((error) => console.error("[connection] Reconnect failed:", error.message))
            .finally(() => { reconnecting = false; });
        }, 1000);
      }
    }

    if (connection === "open") {
      reconnecting = false;
      runtime.botSocket = sock;
      botLid = normalizedBotLid(sock);
      console.log("✅ Bot online");
      console.log(`[AI] ${groqClients.length} Groq key(s) loaded`);
      console.log("Bot JID:", sock.user?.id);
      console.log("Bot LID:", botLid);
      addToFeed({ type: "system", message: "Bot connected to WhatsApp" });
    }
  });

  sock.ev.on("messages.upsert", async (upsert) => {
    const botJid = sock.user?.id;
    if (!botJid) return;
    if (!botLid) botLid = normalizedBotLid(sock);

    try {
      await onMessage(sock, botJid, botLid, upsert);
    } catch (error) {
      console.error("[error]", error);
    }
  });

  return sock;
}

module.exports = { startBot };
