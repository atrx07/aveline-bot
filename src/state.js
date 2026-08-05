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
  debugPipeline: {
    version: 2,
    mode: "explicit-handler-pipeline",
    active: true,
    initializedAt: Date.now(),
    identityListenersAttached: false,
    identityAttachedAt: null,
    messagesSeen: 0,
    tracesCreated: 0,
    preprocessErrors: 0,
    lastMessageSeenAt: null,
    lastTraceAt: null,
    lastPreparedAt: null,
    lastRawText: null,
    lastParsedText: null,
    lastIdentityError: null,
  },
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

function noteDebugMessageSeen() {
  runtime.debugPipeline.messagesSeen++;
  runtime.debugPipeline.lastMessageSeenAt = Date.now();
}

function noteDebugPreprocessError(error) {
  runtime.debugPipeline.preprocessErrors++;
  runtime.debugPipeline.lastIdentityError = {
    name: error?.name || "Error",
    message: String(error?.message || error || "Unknown error").slice(0, 2000),
  };
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
  runtime.debugPipeline.tracesCreated++;
  runtime.debugPipeline.lastTraceAt = now;
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

function getDebugHealth() {
  const pipeline = runtime.debugPipeline;
  return {
    ...pipeline,
    traceCount: debugTraces.length,
    healthy: Boolean(
      pipeline.active &&
      pipeline.identityListenersAttached &&
      pipeline.tracesCreated <= pipeline.messagesSeen
    ),
    diagnosis: !pipeline.active
      ? "debug pipeline disabled"
      : !pipeline.identityListenersAttached
        ? "identity listeners are not attached to the active WhatsApp socket"
        : pipeline.messagesSeen > 0 && pipeline.tracesCreated === 0
          ? "messages are reaching the handler but traces are not being created"
          : pipeline.preprocessErrors > 0
            ? "pipeline active with preprocessing errors"
            : "explicit tracing pipeline active",
  };
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
  noteDebugMessageSeen,
  noteDebugPreprocessError,
  createDebugTrace,
  mutateDebugTrace,
  updateDebugTrace,
  appendGroqCall,
  finishGroqCall,
  getDebugTraces,
  getDebugHealth,
  clearDebugTraces,
};
