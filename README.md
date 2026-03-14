# Aveline 🤍

> A WhatsApp AI chatbot with personality, memory, and soul.

Aveline is a smart, expressive WhatsApp bot powered by Groq LLMs. She has her own personality, adapts her mood to each person she talks to, and remembers conversations across sessions. Built with Baileys and deployed on Railway.

-----

## Features

- **Persistent memory** — Aveline remembers conversations per person, even after restarts, via Upstash Redis
- **Per-person mood** — She picks up on the emotional tone of each message and adapts her personality accordingly
- **Multi-key rotation** — Rotates across multiple Groq API keys before falling back to a different model
- **Model fallback chain** — Falls back through multiple LLMs if a model hits rate limits or times out
- **Group chat support** — Only responds when mentioned or replied to in group chats
- **Railway ready** — Auth session restore, keep-alive HTTP server, environment-based config

-----

## Tech Stack

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web API
- **[Groq](https://groq.com)** — LLM inference (fast and free tier available)
- **[Upstash Redis](https://upstash.com)** — Persistent memory and mood storage
- **[Railway](https://railway.app)** — Hosting and deployment

-----

## Model Priority

```
1. llama-3.3-70b-versatile  (primary)
2. llama-3.1-8b-instant     (fallback)
3. openai/gpt-oss-120b      (last resort)
```

For each model, all API keys are tried before moving to the next model.

-----

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/atrx07/aveline-bot.git
cd aveline-bot
npm install
```

### 2. Configure environment variables

Create a `.env` file:

```env
GROQ_API_KEY_1=your_first_groq_key
GROQ_API_KEY_2=your_second_groq_key
GROQ_API_KEY_3=your_third_groq_key
GROQ_API_KEY=dummy

UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
```

> Tip: Create multiple Groq accounts to maximize your free tier token limits across keys.

### 3. Run locally

```bash
npm start
```

Scan the QR code that appears in the terminal with WhatsApp.

-----

## Deploying to Railway

### 1. Encode your auth session

After scanning QR locally, encode your `creds.json`:

```bash
base64 auth/creds.json | tr -d '\n' > creds_b64.txt
cat creds_b64.txt | termux-clipboard-set  # or copy manually
```

### 2. Add Railway environment variables

```
GROQ_API_KEY        = dummy
GROQ_API_KEY_1      = your_first_groq_key
GROQ_API_KEY_2      = your_second_groq_key
GROQ_API_KEY_3      = your_third_groq_key
UPSTASH_REDIS_REST_URL   = your_upstash_url
UPSTASH_REDIS_REST_TOKEN = your_upstash_token
CREDS_BASE64        = (paste encoded creds here)
```

### 3. Deploy

Push to GitHub — Railway auto-deploys on every push.

```bash
git push
```

-----

## How It Works

```
User message
    ↓
Detect mood (single API call)
    ↓
Save mood to Redis
    ↓
Load conversation history from Redis
    ↓
Build system prompt with current mood
    ↓
Generate reply (with key rotation + model fallback)
    ↓
Save updated memory to Redis
    ↓
Send reply
```

-----

## Personality

Aveline is designed to feel human — not like a typical chatbot. She’s warm, witty, slightly teasing, and emotionally intelligent. Her mood shifts based on the conversation and is remembered per person.

She won’t tell you who made her unless you ask 😏

-----

## Author

Made by **[atrx07](https://github.com/atrx07)**

[![Instagram](https://img.shields.io/badge/Instagram-@atrx07-E4405F?style=flat&logo=instagram)](https://instagram.com/atrx07)
[![GitHub](https://img.shields.io/badge/GitHub-atrx07-181717?style=flat&logo=github)](https://github.com/atrx07)

-----

## License

MIT
