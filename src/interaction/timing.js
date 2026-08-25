"use strict";

const MIN_REPLY_DELAY_MS = 650;
const MAX_REPLY_DELAY_MS = 6500;
const BASE_THINK_MS = 450;
const READING_MS_PER_CHAR = 7;
const TYPING_MS_PER_CHAR = 18;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function messageComplexity(text) {
  const value = String(text || "").trim();
  if (!value) return 0;

  const words = value.split(/\s+/).filter(Boolean).length;
  const questionCount = (value.match(/\?/g) || []).length;
  const lineCount = value.split(/\n+/).filter((line) => line.trim()).length;
  const complexity = Math.min(1, (words / 55) + (questionCount * 0.08) + (Math.max(0, lineCount - 1) * 0.05));
  return complexity;
}

function calculateNaturalReplyDelay({ incomingText, replyText, mood = "neutral", elapsedMs = 0 }) {
  const incoming = String(incomingText || "");
  const reply = String(replyText || "");
  const complexity = messageComplexity(incoming);

  const readingTime = Math.min(1100, incoming.length * READING_MS_PER_CHAR);
  const typingTime = Math.min(4400, reply.length * TYPING_MS_PER_CHAR);
  const thinkingTime = BASE_THINK_MS + (complexity * 1050);

  let targetTotal = readingTime + typingTime + thinkingTime;

  if (mood === "annoyed") targetTotal *= 0.72;
  if (mood === "affectionate") targetTotal *= 1.08;

  // Small non-deterministic variation keeps identical-length replies from
  // producing a mechanical delay signature.
  targetTotal *= randomBetween(0.86, 1.14);
  targetTotal = clamp(targetTotal, MIN_REPLY_DELAY_MS, MAX_REPLY_DELAY_MS);

  // Model inference already looks like thinking/typing time to the user, so
  // only wait for the remainder instead of stacking an artificial delay on top.
  const remainingMs = clamp(Math.round(targetTotal - Math.max(0, elapsedMs)), 0, MAX_REPLY_DELAY_MS);

  return {
    targetTotalMs: Math.round(targetTotal),
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    remainingMs,
    complexity: Number(complexity.toFixed(3)),
  };
}

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  calculateNaturalReplyDelay,
  sleep,
};
