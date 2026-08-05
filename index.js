"use strict";

require("dotenv").config();

const { createApp } = require("./src/api/app");
const { startBot } = require("./src/whatsapp/bot");
const { loadStats } = require("./src/storage");

async function main() {
  await loadStats();

  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[api] Server running on port ${port}`));

  await startBot();
}

main().catch((error) => {
  console.error("[startup] Fatal error:", error);
  process.exitCode = 1;
});
