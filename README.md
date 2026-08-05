# Aveline 🤍

> A WhatsApp AI chatbot with personality, memory, and soul.

Aveline is an expressive WhatsApp bot powered by Groq LLMs. She adapts her mood to each person, remembers conversations through Upstash Redis, supports groups and mood-based stickers, and includes a protected management API.

---

## Features

- **Persistent memory** — remembers conversations per chat through Upstash Redis
- **Per-person mood** — adapts her tone based on the current conversation
- **Multi-key rotation** — tries every configured Groq key before switching models
- **Model fallback chain** — continues through multiple LLMs after limits or timeouts
- **Group support** — responds only when mentioned or replied to
- **Mood stickers** — captures, classifies, and sends stickers per chat mood
- **Management API** — status, statistics, pause/resume, blacklist, memory controls, announcements, and sticker management
- **Protected browser pairing** — renders WhatsApp's rotating QR cleanly at `/pair` instead of mangling it in Railway logs
- **Railway-ready persistence** — keeps the complete Baileys auth directory on a mounted volume

---

## Tech Stack

- **Baileys** — WhatsApp Web connection
- **Groq** — LLM inference
- **Upstash Redis** — memory, mood, statistics, and sticker storage
- **Express** — health endpoint, pairing page, and management API
- **Railway** — hosting and persistent auth volume

---

## Model Priority

```text
1. llama-3.3-70b-versatile
2. llama-3.1-8b-instant
3. openai/gpt-oss-120b
```

For each model, Aveline tries all configured API keys before moving to the next model.

---

## Local Setup

### 1. Clone and install

```bash
git clone https://github.com/atrx07/aveline-bot.git
cd aveline-bot
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in the values in `.env`. At least one Groq API key is required.

Generate a strong dashboard token, for example:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Validate and start

```bash
npm run check
npm start
```

Open:

```text
http://localhost:3000/pair
```

Your browser will request the `DASHBOARD_USER` and `DASHBOARD_PASS` values from `.env`. Scan the clean QR image using **WhatsApp → Linked devices → Link a device**.

---

## Fresh Railway Deployment

### 1. Create the service

Create a Railway project from the GitHub repository `atrx07/aveline-bot`. Railway will install the Node dependencies and run `npm start`.

### 2. Add service variables

Add the following variables to the Railway service:

```env
GROQ_API_KEY_1=your_key
GROQ_API_KEY_2=optional_second_key
GROQ_API_KEY_3=optional_third_key

UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

DASHBOARD_USER=your_dashboard_username
DASHBOARD_PASS=your_dashboard_password
DASHBOARD_TOKEN=a_long_random_token
```

Do **not** add the old `CREDS_BASE64`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, or `RAILWAY_TOKEN` variables. They belong to the retired single-file auth workflow and are ignored by the bootstrap.

### 3. Attach the WhatsApp auth volume

Add a Railway volume to the Aveline service and mount it at:

```text
/app/auth
```

Baileys writes its auth files to `./auth`, which resolves to `/app/auth` on Railway. Persisting that complete directory prevents the linked-device session from disappearing during normal redeployments or restarts.

### 4. Generate a public domain

Generate a Railway domain for the service. The root endpoint returns:

```text
ok
```

Use that endpoint as the basic deployment health check.

### 5. Pair WhatsApp in the browser

Open:

```text
https://YOUR-RAILWAY-DOMAIN/pair
```

The browser will show an HTTP Basic Authentication prompt. Enter the same `DASHBOARD_USER` and `DASHBOARD_PASS` configured in Railway.

The page displays the latest WhatsApp QR as a proper PNG and refreshes automatically whenever WhatsApp rotates it. Scan it using **WhatsApp → Linked devices → Link a device**.

After the connection opens:

- the page changes to **Connected**
- the live QR is cleared from application memory
- the resulting Baileys auth files remain in `/app/auth` on the Railway volume
- later deployments reconnect without another QR unless the linked device is revoked or the volume is wiped

The deployment logs show only the protected pairing-page address; they no longer print the block-character QR.

---

## Pairing Page Security

- `/pair` and `/pair/status` require the dashboard username and password through HTTP Basic Authentication
- the current QR exists only in application memory
- QR responses use no-cache headers
- the QR is cleared after Aveline connects
- the page has a restrictive Content Security Policy and cannot be framed by another site

Treat the pairing page and dashboard credentials as sensitive. A live WhatsApp pairing QR authorizes a new linked device.

---

## Startup Safety

`bootstrap.js` runs before the bot and:

- checks that the required Groq, Upstash, and dashboard variables exist
- verifies that the auth directory is readable and writable
- disables the retired `CREDS_BASE64` and Railway GraphQL credential-sync path
- captures Baileys' QR payload and renders it on the protected browser pairing page
- prevents the terminal QR and Groq key prefixes from being printed in deployment logs

Run the same syntax validation locally with:

```bash
npm run check
```

---

## How It Works

```text
Incoming message
      ↓
Detect mood
      ↓
Store mood in Redis
      ↓
Load conversation memory
      ↓
Build Aveline's system prompt
      ↓
Generate a reply with key rotation and model fallback
      ↓
Save updated memory
      ↓
Send reply and optionally a mood sticker
```

---

## Personality

Aveline is designed to feel warm, witty, playful, slightly teasing, and emotionally aware. Her tone shifts naturally with each conversation and is remembered per person.

She won’t tell you who made her unless you ask 😏

---

## Author

Made by **[atrx07](https://github.com/atrx07)**

[![Instagram](https://img.shields.io/badge/Instagram-@atrx07-E4405F?style=flat&logo=instagram)](https://instagram.com/atrx07)
[![GitHub](https://img.shields.io/badge/GitHub-atrx07-181717?style=flat&logo=github)](https://github.com/atrx07)

---

## License

MIT
