"use strict";

const { Redis } = require("@upstash/redis");
const Groq = require("groq-sdk");

const MEMORY_LIMIT = 20;
const MODELS = [
  "qwen/qwen3.6-27b",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
];
const DECISION_MODEL = "openai/gpt-oss-20b";
const VALID_MOODS = ["happy", "neutral", "teasing", "annoyed", "affectionate"];

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const replyKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
];

const groqKeySlots = replyKeys.map((apiKey, index) => ({
  keyNumber: index + 1,
  client: apiKey ? new Groq({ apiKey }) : null,
}));

const groqClients = groqKeySlots
  .filter((slot) => slot.client)
  .map((slot) => slot.client);

const decisionGroqClient = process.env.GROQ_API_KEY_4
  ? new Groq({ apiKey: process.env.GROQ_API_KEY_4 })
  : null;

module.exports = {
  MEMORY_LIMIT,
  MODELS,
  DECISION_MODEL,
  VALID_MOODS,
  redis,
  groqClients,
  groqKeySlots,
  decisionGroqClient,
  // Compatibility alias for older modules during staged deployments.
  moodGroqClient: decisionGroqClient,
};
