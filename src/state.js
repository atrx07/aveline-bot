"use strict";

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 10 * 60 * 1000;

const stats = {
  totalMessages: 0,
  messagesToday: 0,
  modelUsage: {},
  keyUsage: {},
  rateLimitHits: 0,
  responseTimes: [],
  lastMessageAt: null,
  startedAt: Date.now(),
};

const liveFeed = [];
const loginAttempts = new Map();

const runtime = {
  botPaused: false,
  botSocket: null,
  stickerCaptureMode: false,
};

function addToFeed(entry) {
  liveFeed.unshift({ ...entry, timestamp: Date.now() });
  if (liveFeed.length > 50) liveFeed.pop();
}

function getRateLimit(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null };

  if (entry.lockedUntil && now > entry.lockedUntil) {
    entry.count = 0;
    entry.lockedUntil = null;
  }

  loginAttempts.set(ip, entry);
  return entry;
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
  stats,
  liveFeed,
  runtime,
  addToFeed,
  getRateLimit,
};
