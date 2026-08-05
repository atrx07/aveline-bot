require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");

const REQUIRED_ENV = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "DASHBOARD_USER",
  "DASHBOARD_PASS",
  "DASHBOARD_TOKEN",
];

const pairingState = {
  status: "starting",
  qrDataUrl: null,
  updatedAt: null,
  expiresAt: null,
  generation: 0,
  urlLogged: false,
};

function validateEnvironment() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  const groqKeys = [
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter((key) => key?.trim());

  if (groqKeys.length === 0) {
    missing.push("GROQ_API_KEY_1 (or _2 / _3)");
  }

  if (missing.length > 0) {
    console.error("[startup] Missing required environment variables:");
    for (const name of missing) console.error(`  - ${name}`);
    console.error("[startup] Add them in Railway Variables and redeploy.");
    process.exit(1);
  }

  if (process.env.DASHBOARD_TOKEN.length < 32) {
    console.warn("[startup] DASHBOARD_TOKEN should be a random value of at least 32 characters.");
  }

  console.log(`[startup] Environment validated (${groqKeys.length} Groq key(s) loaded).`);
}

function preparePersistentAuthDirectory() {
  const authDir = path.resolve("./auth");

  try {
    fs.mkdirSync(authDir, { recursive: true });
    fs.accessSync(authDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    console.error(`[startup] Auth directory is not writable: ${authDir}`);
    console.error("[startup] Mount the Railway volume at /app/auth.");
    console.error(`[startup] ${error.message}`);
    process.exit(1);
  }

  if (process.env.RAILWAY_ENVIRONMENT && authDir !== "/app/auth") {
    console.warn(`[startup] Railway auth path resolved to ${authDir}; expected /app/auth.`);
  }

  console.log(`[startup] WhatsApp auth directory ready: ${authDir}`);
}

function disableLegacyRailwayAuthSync() {
  const legacyVariables = [
    "CREDS_BASE64",
    "RAILWAY_PROJECT_ID",
    "RAILWAY_SERVICE_ID",
    "RAILWAY_TOKEN",
  ];

  const configuredLegacyVariables = legacyVariables.filter((name) => process.env[name]);
  if (configuredLegacyVariables.length > 0) {
    console.warn(
      `[startup] Ignoring deprecated Railway auth variables: ${configuredLegacyVariables.join(", ")}`
    );
  }

  // index.js still contains the previous migration fallback. Removing these values
  // before loading it makes the old flow inert while the full auth directory lives
  // on the Railway volume.
  for (const name of legacyVariables) delete process.env[name];
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function pairingAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      const username = separator >= 0 ? decoded.slice(0, separator) : "";
      const password = separator >= 0 ? decoded.slice(separator + 1) : "";

      if (
        safeEqual(username, process.env.DASHBOARD_USER) &&
        safeEqual(password, process.env.DASHBOARD_PASS)
      ) {
        return next();
      }
    } catch {}
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="Aveline pairing", charset="UTF-8"');
  res.setHeader("Cache-Control", "no-store");
  return res.status(401).send("Authentication required");
}

function getPublicPairingUrl() {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
  if (!domain) return "/pair";
  if (/^https?:\/\//i.test(domain)) return `${domain.replace(/\/$/, "")}/pair`;
  return `https://${domain.replace(/\/$/, "")}/pair`;
}

function getPairingSnapshot() {
  const now = Date.now();
  const qrIsFresh = pairingState.qrDataUrl && pairingState.expiresAt > now;
  let status = pairingState.status;

  if (status === "waiting" && !qrIsFresh) status = "refreshing";

  return {
    status,
    qrDataUrl: qrIsFresh ? pairingState.qrDataUrl : null,
    updatedAt: pairingState.updatedAt,
  };
}

function pairingPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Aveline Pairing</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top, #2b2340 0, #111016 45%, #09090c 100%); color: #f8f6ff; }
    main { width: min(92vw, 520px); padding: 32px; border: 1px solid rgba(255,255,255,.12); border-radius: 24px; background: rgba(20,18,27,.88); box-shadow: 0 24px 80px rgba(0,0,0,.45); text-align: center; }
    h1 { margin: 0 0 8px; font-size: clamp(28px, 7vw, 42px); }
    p { margin: 8px 0; color: #c9c3d8; line-height: 1.55; }
    #qr-wrap { display: none; margin: 24px auto 16px; width: fit-content; padding: 14px; border-radius: 18px; background: white; }
    #qr { display: block; width: min(72vw, 360px); height: auto; }
    .status { display: inline-flex; align-items: center; gap: 9px; margin-top: 14px; padding: 9px 14px; border-radius: 999px; background: rgba(255,255,255,.08); font-size: 14px; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #f4bf5f; box-shadow: 0 0 14px currentColor; }
    .connected .dot { background: #57dc8c; }
    .error .dot { background: #ff6f78; }
    small { display: block; margin-top: 20px; color: #8f879f; }
  </style>
</head>
<body>
  <main id="card">
    <h1>Aveline 🤍</h1>
    <p id="message">Preparing a fresh WhatsApp pairing code…</p>
    <div id="qr-wrap"><img id="qr" alt="WhatsApp pairing QR code"></div>
    <div id="status" class="status"><span class="dot"></span><span id="status-text">Starting</span></div>
    <small>Use WhatsApp → Linked devices → Link a device. This page is protected by your dashboard login and the QR stays only in server memory.</small>
  </main>
  <script>
    const card = document.getElementById("card");
    const qrWrap = document.getElementById("qr-wrap");
    const qr = document.getElementById("qr");
    const message = document.getElementById("message");
    const status = document.getElementById("status");
    const statusText = document.getElementById("status-text");

    async function refresh() {
      try {
        const response = await fetch("/pair/status", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error("status " + response.status);
        const data = await response.json();

        card.className = "";
        status.className = "status";

        if (data.status === "connected") {
          card.className = "connected";
          status.className = "status connected";
          statusText.textContent = "Connected";
          message.textContent = "Aveline is linked to WhatsApp. The session is now stored on the Railway volume.";
          qrWrap.style.display = "none";
          qr.removeAttribute("src");
          return;
        }

        if (data.qrDataUrl) {
          qr.src = data.qrDataUrl;
          qrWrap.style.display = "block";
          statusText.textContent = "Waiting for scan";
          message.textContent = "Scan this code with WhatsApp. It refreshes automatically when WhatsApp rotates it.";
        } else {
          qrWrap.style.display = "none";
          qr.removeAttribute("src");
          statusText.textContent = data.status === "reconnecting" ? "Reconnecting" : "Generating QR";
          message.textContent = "A fresh code is being prepared. Keep this page open.";
        }
      } catch (error) {
        status.className = "status error";
        statusText.textContent = "Unavailable";
        message.textContent = "The pairing status could not be loaded. Refresh this page or check the deployment logs.";
        qrWrap.style.display = "none";
      }
    }

    refresh();
    setInterval(refresh, 1500);
  </script>
</body>
</html>`;
}

function installPairingRoutes(app) {
  app.get("/pair", pairingAuth, (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    res.type("html").send(pairingPageHtml());
  });

  app.get("/pair/status", pairingAuth, (_req, res) => {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.json(getPairingSnapshot());
  });
}

function installPairingPage() {
  const realExpress = require("express");
  const wrappedExpress = new Proxy(realExpress, {
    apply(target, thisArg, args) {
      const app = Reflect.apply(target, thisArg, args);
      installPairingRoutes(app);
      return app;
    },
  });
  require.cache[require.resolve("express")].exports = wrappedExpress;

  const terminalQr = require("qrcode-terminal");
  terminalQr.generate = (qrText) => {
    const generation = ++pairingState.generation;
    pairingState.status = "waiting";
    pairingState.qrDataUrl = null;
    pairingState.updatedAt = Date.now();
    pairingState.expiresAt = Date.now() + 60_000;

    QRCode.toDataURL(qrText, {
      type: "image/png",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 512,
    })
      .then((dataUrl) => {
        if (generation !== pairingState.generation) return;
        pairingState.qrDataUrl = dataUrl;
        pairingState.updatedAt = Date.now();
      })
      .catch((error) => {
        if (generation !== pairingState.generation) return;
        pairingState.status = "error";
        pairingState.qrDataUrl = null;
        console.error("[pairing] Failed to render QR image:", error.message);
      });

    if (!pairingState.urlLogged) {
      pairingState.urlLogged = true;
      console.log(`[pairing] Open ${getPublicPairingUrl()} and sign in with the dashboard credentials.`);
    }
  };
}

function monitorLegacyLogs() {
  const originalLog = console.log.bind(console);

  console.log = (...args) => {
    const first = String(args[0] ?? "");
    if (/^\[debug\] Key \d+:/.test(first)) return;

    if (first.includes("✅ Bot online")) {
      pairingState.status = "connected";
      pairingState.qrDataUrl = null;
      pairingState.updatedAt = Date.now();
      pairingState.expiresAt = null;
      pairingState.generation++;
    } else if (first.includes("[connection] reconnecting")) {
      pairingState.status = "reconnecting";
      pairingState.qrDataUrl = null;
      pairingState.updatedAt = Date.now();
    } else if (first.includes("[connection] logged out")) {
      pairingState.status = "starting";
      pairingState.qrDataUrl = null;
      pairingState.updatedAt = Date.now();
      pairingState.urlLogged = false;
    }

    originalLog(...args);
  };
}

validateEnvironment();
preparePersistentAuthDirectory();
disableLegacyRailwayAuthSync();
installPairingPage();
monitorLegacyLogs();

require("./index");
