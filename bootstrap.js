require("dotenv").config();

const fs = require("fs");
const path = require("path");

const REQUIRED_ENV = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "DASHBOARD_USER",
  "DASHBOARD_PASS",
  "DASHBOARD_TOKEN",
];

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

function redactLegacyDebugLogs() {
  const originalLog = console.log.bind(console);

  console.log = (...args) => {
    const first = String(args[0] ?? "");
    if (/^\[debug\] Key \d+:/.test(first)) return;
    originalLog(...args);
  };
}

validateEnvironment();
preparePersistentAuthDirectory();
disableLegacyRailwayAuthSync();
redactLegacyDebugLogs();

require("./index");
