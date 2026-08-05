"use strict";

const crypto = require("crypto");

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 10 * 60 * 1000;
const DEBUG_TRACE_LIMIT = 50;

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
const debugTraces = [];
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

function createDebugTrace(seed = {}) {
  const now = Date.now();
  const trace = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "received",
    ...seed,
  };

  debugTraces.unshift(trace);
  if (debugTraces.length > DEBUG_TRACE_LIMIT) debugTraces.length = DEBUG_TRACE_LIMIT;
  return trace.id;
}

function mutateDebugTrace(traceId, mutator) {
  if (!traceId || typeof mutator !== "function") return null;
  const trace = debugTraces.find((entry) => entry.id === traceId);
  if (!trace) return null;

  mutator(trace);
  trace.updatedAt = Date.now();
  return trace;
}

function updateDebugTrace(traceId, patch = {}) {
  return mutateDebugTrace(traceId, (trace) => {
    Object.assign(trace, patch);
  });
}

function appendGroqCall(traceId, call) {
  return mutateDebugTrace(traceId, (trace) => {
    if (!Array.isArray(trace.groqCalls)) trace.groqCalls = [];
    trace.groqCalls.push(call);
  });
}

function finishGroqCall(traceId, callId, patch) {
  return mutateDebugTrace(traceId, (trace) => {
    const call = trace.groqCalls?.find((entry) => entry.id === callId);
    if (call) Object.assign(call, patch);
  });
}

function getDebugTraces(limit = DEBUG_TRACE_LIMIT) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || DEBUG_TRACE_LIMIT, DEBUG_TRACE_LIMIT));
  return debugTraces.slice(0, safeLimit);
}

function clearDebugTraces() {
  const cleared = debugTraces.length;
  debugTraces.length = 0;
  return cleared;
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATION,
  DEBUG_TRACE_LIMIT,
  stats,
  liveFeed,
  runtime,
  addToFeed,
  getRateLimit,
  createDebugTrace,
  mutateDebugTrace,
  updateDebugTrace,
  appendGroqCall,
  finishGroqCall,
  getDebugTraces,
  clearDebugTraces,
};
