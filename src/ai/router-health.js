"use strict";

const { redis, MODELS, groqKeySlots } = require("../config");

const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
const TIMEOUT_COOLDOWN_MS = 60 * 1000;
const TEMPORARY_COOLDOWN_MS = 2 * 60 * 1000;
const PREFIX = "groq:router:health";

const health = new Map();
let hydrationPromise = null;

function pairId(keyNumber, model) {
  return `key${keyNumber}|${model}`;
}

function redisKey(keyNumber, model) {
  return `${PREFIX}:${keyNumber}:${encodeURIComponent(model)}`;
}

function defaultState(keyNumber, model) {
  return {
    keyNumber,
    model,
    status: "unknown",
    cooldownUntil: 0,
    reason: null,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    failureCount: 0,
    lastError: null,
    disabled: false,
    modelUnavailable: false,
  };
}

function normalizeState(value, keyNumber, model) {
  const base = defaultState(keyNumber, model);
  if (!value || typeof value !== "object") return base;
  return {
    ...base,
    ...value,
    keyNumber,
    model,
    cooldownUntil: Number(value.cooldownUntil) || 0,
    lastSuccessAt: Number(value.lastSuccessAt) || 0,
    lastFailureAt: Number(value.lastFailureAt) || 0,
    failureCount: Number(value.failureCount) || 0,
    disabled: Boolean(value.disabled),
    modelUnavailable: Boolean(value.modelUnavailable),
  };
}

async function hydrate() {
  if (hydrationPromise) return hydrationPromise;
  hydrationPromise = (async () => {
    for (const model of MODELS) {
      for (const slot of groqKeySlots) {
        const id = pairId(slot.keyNumber, model);
        try {
          const saved = await redis.get(redisKey(slot.keyNumber, model));
          health.set(id, normalizeState(saved, slot.keyNumber, model));
        } catch (error) {
          console.error(`[router] Failed to load ${id}:`, error.message);
          health.set(id, defaultState(slot.keyNumber, model));
        }
      }
    }
  })();
  return hydrationPromise;
}

function getState(keyNumber, model) {
  const id = pairId(keyNumber, model);
  if (!health.has(id)) health.set(id, defaultState(keyNumber, model));
  return health.get(id);
}

async function persist(state) {
  try {
    await redis.set(redisKey(state.keyNumber, state.model), state);
  } catch (error) {
    console.error(`[router] Failed to persist ${pairId(state.keyNumber, state.model)}:`, error.message);
  }
}

async function disableKey(keyNumber, reason, errorMessage) {
  const now = Date.now();
  await Promise.all(MODELS.map(async (model) => {
    const state = getState(keyNumber, model);
    Object.assign(state, {
      status: "disabled",
      disabled: true,
      cooldownUntil: 0,
      reason,
      lastFailureAt: now,
      failureCount: state.failureCount + 1,
      lastError: errorMessage,
    });
    await persist(state);
  }));
}

function classifyFailure(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = String(error?.message || error || "Unknown error").slice(0, 1000);

  if (status === 401 || status === 403) {
    return { type: "disabled", durationMs: 0, reason: `http_${status}`, message };
  }
  if (status === 404) {
    return { type: "model_unavailable", durationMs: 0, reason: "model_unavailable", message };
  }
  if (status === 429) {
    return { type: "cooldown", durationMs: RATE_LIMIT_COOLDOWN_MS, reason: "rate_limit", message };
  }
  if (message === "timeout") {
    return { type: "cooldown", durationMs: TIMEOUT_COOLDOWN_MS, reason: "timeout", message };
  }
  if (status >= 500 || status === 408 || status === 0) {
    return { type: "cooldown", durationMs: TEMPORARY_COOLDOWN_MS, reason: status ? `http_${status}` : "network", message };
  }
  return { type: "failure", durationMs: 0, reason: status ? `http_${status}` : "request_error", message };
}

async function markFailure(keyNumber, model, error) {
  await hydrate();
  const failure = classifyFailure(error);
  if (failure.type === "disabled") {
    await disableKey(keyNumber, failure.reason, failure.message);
    return failure;
  }

  const state = getState(keyNumber, model);
  const now = Date.now();

  if (failure.type === "model_unavailable") {
    Object.assign(state, {
      status: "model_unavailable",
      modelUnavailable: true,
      cooldownUntil: 0,
      reason: failure.reason,
      lastFailureAt: now,
      failureCount: state.failureCount + 1,
      lastError: failure.message,
    });
    await persist(state);
    return failure;
  }

  Object.assign(state, {
    status: failure.type === "cooldown" ? "cooldown" : "available",
    cooldownUntil: failure.durationMs ? now + failure.durationMs : 0,
    reason: failure.reason,
    lastFailureAt: now,
    failureCount: state.failureCount + 1,
    lastError: failure.message,
  });
  await persist(state);
  return failure;
}

async function markSuccess(keyNumber, model) {
  await hydrate();
  const state = getState(keyNumber, model);
  Object.assign(state, {
    status: "available",
    cooldownUntil: 0,
    reason: null,
    lastSuccessAt: Date.now(),
    failureCount: 0,
    lastError: null,
    disabled: false,
    modelUnavailable: false,
  });
  await persist(state);
}

async function eligibility(keyNumber, model, now = Date.now()) {
  await hydrate();
  const state = getState(keyNumber, model);
  if (state.disabled) return { eligible: false, state, reason: "disabled", remainingMs: null };
  if (state.modelUnavailable) {
    return { eligible: false, state, reason: "model_unavailable", remainingMs: null };
  }
  if (state.cooldownUntil > now) {
    return {
      eligible: false,
      state,
      reason: "cooldown",
      remainingMs: state.cooldownUntil - now,
    };
  }
  if (state.cooldownUntil && state.cooldownUntil <= now) {
    state.status = "ready_to_probe";
  }
  return { eligible: true, state, reason: null, remainingMs: 0 };
}

async function getRouterHealth() {
  await hydrate();
  const now = Date.now();
  return {
    serverTime: now,
    cooldowns: {
      rateLimitMs: RATE_LIMIT_COOLDOWN_MS,
      timeoutMs: TIMEOUT_COOLDOWN_MS,
      temporaryMs: TEMPORARY_COOLDOWN_MS,
    },
    models: MODELS.map((model) => ({
      model,
      keys: groqKeySlots.map((slot) => {
        const state = { ...getState(slot.keyNumber, model) };
        const configured = Boolean(slot.client);
        let status = state.status;
        if (!configured) status = "not_configured";
        else if (state.disabled) status = "disabled";
        else if (state.modelUnavailable) status = "model_unavailable";
        else if (state.cooldownUntil > now) status = "cooldown";
        else if (state.cooldownUntil) status = "ready_to_probe";
        else if (status === "unknown") status = "available";
        return {
          ...state,
          configured,
          status,
          remainingMs: state.cooldownUntil > now ? state.cooldownUntil - now : 0,
        };
      }),
    })),
  };
}

module.exports = {
  hydrateRouterHealth: hydrate,
  getPairEligibility: eligibility,
  markPairFailure: markFailure,
  markPairSuccess: markSuccess,
  getRouterHealth,
};
