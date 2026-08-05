# Aveline architecture

Aveline is split by responsibility so WhatsApp transport, AI behavior, persistence, and the dashboard can evolve independently.

```text
bootstrap.js                 Railway startup validation and protected QR pairing
identity-layer.js            Preload hook for canonical identity, mention resolution, and exact Groq tracing
identity-store.js            Redis-backed cross-chat identity registry
index.js                     Minimal application entrypoint
src/
  config.js                  Redis, Groq clients, models, and shared constants
  state.js                   Runtime bot state, metrics, login limits, live feed, and in-memory debug traces
  storage.js                 All legacy memory, mood, name, blacklist, stats, and sticker persistence
  ai/
    prompt.js                Aveline's system prompt
    service.js               Mood analysis, model/key fallback, conversational memory, and trace annotations
  whatsapp/
    bot.js                   Baileys socket lifecycle and reconnect handling
    message-utils.js         Message text, context, sender, and mention helpers
    message-handler.js       Incoming message pipeline, replies, trace status, feed updates, and sticker capture
  api/
    app.js                   Express assembly
    auth.js                  Dashboard login and bearer authentication
    middleware.js            CORS
    routes/
      dashboard.js           Status, chats, controls, memory, moods, and blacklist
      stickers.js            Sticker capture, classification, clearing, and chat toggles
      announce.js            Rate-spaced broadcast announcements
      debug.js               Protected in-memory parser/Groq trace inspection and clearing
scripts/
  check.js                   Cross-platform syntax validation
```

## Data boundaries

- `storage.js` preserves the existing Redis keys, so the refactor requires no migration.
- `identity-store.js` owns only the additive `identity:*` keys.
- Raw conversation memory remains scoped by chat in `memory:<chatId>`.
- The identity preload may recognize a person across chats, but it never transfers raw messages between chats.
- Debug traces are never written to Redis. They remain in Railway process memory, keep only the latest 50 entries, and disappear on restart or deployment.
- Debug records intentionally contain raw WhatsApp JIDs and message text, so `/api/debug/*` remains protected by the dashboard bearer token.
- Groq API keys, dashboard credentials, WhatsApp auth files, and other secrets are never included in traces.

## Debug trace flow

1. `identity-layer.js` captures the original Baileys text field and mention metadata before parsing.
2. The canonical identity resolver sanitizes the message and records each expected mention replacement.
3. `message-handler.js` records filtering decisions, the exact text used by the handler, mood, and delivery status.
4. The Groq preload wrapper records the exact post-identity-injection request, model/client attempt, output, timing, and errors.
5. `/api/debug/traces` exposes the protected in-memory timeline to the dashboard debug page.

## Startup flow

1. `identity-layer.js` is preloaded by Node and wraps Groq/Baileys identity and debug behavior.
2. `bootstrap.js` validates Railway variables, prepares `/app/auth`, and installs `/pair`.
3. `index.js` restores metrics, starts Express, and opens the WhatsApp socket.
