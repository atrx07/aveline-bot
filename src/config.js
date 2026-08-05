"use strict";

const { Redis } = require("@upstash/redis");
const Groq = require("groq-sdk");

const MEMORY_LIMIT = 20;
const MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
];
const VALID_MOODS = ["happy", "neutral", "teasing", "annoyed", "affectionate"];

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const groqClients = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
]
  .filter(Boolean)
  .map((apiKey) => new Groq({ apiKey }));

module.exports = {
  MEMORY_LIMIT,
  MODELS,
  VALID_MOODS,
  redis,
  groqClients,
};
