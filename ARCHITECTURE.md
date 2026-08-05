# Aveline architecture

Aveline is split by responsibility so WhatsApp transport, AI behavior, persistence, and the dashboard can evolve independently.

```text
bootstrap.js                 Railway startup validation and protected QR pairing
identity-layer.js            Preload hook for canonical identity and mention resolution
identity-store.js            Redis-backed cross-chat identity registry
index.js                     Minimal application entrypoint
src/
  config.js                  Redis, Groq clients, models, and shared constants
  state.js                   Runtime bot state, metrics, login limits, and live feed
  storage.js                 All legacy memory, mood, name, blacklist, stats, and sticker persistence
  ai/
    prompt.js                Aveline's system prompt
    service.js               Mood analysis, model/key fallback, and conversational memory
  whatsapp/
    bot.js                   Baileys socket lifecycle and reconnect handling
    message-utils.js         Message text, context, sender, and mention helpers
    message-handler.js       Incoming message pipeline, replies, feed updates, and sticker capture
  api/
    app.js                   Express assembly
    auth.js                  Dashboard login and bearer authentication
    middleware.js            CORS
    routes/
      dashboard.js           Status, chats, controls, memory, moods, and blacklist
      stickers.js            Sticker capture, classification, clearing, and chat toggles
      announce.js            Rate-spaced broadcast announcements
scripts/
  check.js                   Cross-platform syntax validation
```

## Data boundaries

- `storage.js` preserves the existing Redis keys, so the refactor requires no migration.
- `identity-store.js` owns only the additive `identity:*` keys.
- Raw conversation memory remains scoped by chat in `memory:<chatId>`.
- The identity preload may recognize a person across chats, but it never transfers raw messages between chats.

## Startup flow

1. `identity-layer.js` is preloaded by Node and wraps Groq/Baileys identity behavior.
2. `bootstrap.js` validates Railway variables, prepares `/app/auth`, and installs `/pair`.
3. `index.js` restores metrics, starts Express, and opens the WhatsApp socket.
