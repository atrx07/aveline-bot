"use strict";

const { redis, MEMORY_LIMIT } = require("../config");
const { loadMemory, saveMemory } = require("../storage");

const RESPONSE_ACTIONS = ["reply", "react", "silent"];
const RESPONSE_IMPORTANCE = ["low", "normal", "high"];
const REACTION_EMOJIS = [
  "😂", "😭", "💀", "😒", "🙄", "😐", "😏", "❤️", "🥰", "👍",
  "👀", "🤨", "🔥", "👏", "🙏", "👋", "🤝", "🫠", "😮", "😌",
];

const cache = new Map();

function interactionKey(personId) {
  return `interaction:${personId}`;
}

function defaultState(personId) {
  return {
    schemaVersion: 1,
    personId,
    annoyedLatch: false,
    recentActions: [],
    consecutiveReactions: 0,
    lastActionAt: null,
    updatedAt: Date.now(),
  };
}

function normalizeState(value, personId) {
  const base = defaultState(personId);
  if (!value || typeof value !== "object") return base;
  return {
    ...base,
    ...value,
    personId,
    annoyedLatch: Boolean(value.annoyedLatch),
    recentActions: Array.isArray(value.recentActions) ? value.recentActions.slice(-8) : [],
    consecutiveReactions: Math.max(0, Number(value.consecutiveReactions) || 0),
    lastActionAt: Number(value.lastActionAt) || null,
    updatedAt: Number(value.updatedAt) || base.updatedAt,
  };
}

async function loadInteractionState(personId) {
  if (!personId) return null;
  if (cache.has(personId)) return cache.get(personId);
  try {
    const saved = await redis.get(interactionKey(personId));
    const state = normalizeState(saved, personId);
    cache.set(personId, state);
    return state;
  } catch (error) {
    console.error(`[interaction] Failed to load ${personId}:`, error.message);
    const state = defaultState(personId);
    cache.set(personId, state);
    return state;
  }
}

async function saveInteractionState(state) {
  if (!state?.personId) return;
  state.updatedAt = Date.now();
  cache.set(state.personId, state);
  try {
    await redis.set(interactionKey(state.personId), state);
  } catch (error) {
    console.error(`[interaction] Failed to save ${state.personId}:`, error.message);
  }
}

function fallbackReaction(mood) {
  if (mood === "annoyed") return "😒";
  if (mood === "teasing") return "😏";
  if (mood === "affectionate") return "❤️";
  if (mood === "happy") return "😂";
  return "👍";
}

function normalizeResponseDecision(raw, mood) {
  const action = RESPONSE_ACTIONS.includes(raw?.action) ? raw.action : "reply";
  const importance = RESPONSE_IMPORTANCE.includes(raw?.importance) ? raw.importance : "normal";
  const requestedReaction = typeof raw?.reaction === "string" ? raw.reaction.trim() : "";
  const reaction = REACTION_EMOJIS.includes(requestedReaction)
    ? requestedReaction
    : fallbackReaction(mood);

  return {
    action,
    reaction,
    reply_required: Boolean(raw?.reply_required),
    importance,
    silence_safe: Boolean(raw?.silence_safe),
    repair_signal: Boolean(raw?.repair_signal),
    reason: typeof raw?.reason === "string" ? raw.reason.slice(0, 240) : "",
  };
}

function recentNonTextCount(state, limit = 5) {
  return (state?.recentActions || [])
    .slice(-limit)
    .filter((entry) => entry.action === "react" || entry.action === "silent")
    .length;
}

function lastAction(state) {
  const actions = state?.recentActions || [];
  return actions.length ? actions[actions.length - 1] : null;
}

async function resolveResponseAction(personId, rawDecision, mood, providedState = null) {
  const state = providedState || await loadInteractionState(personId);
  const decision = normalizeResponseDecision(rawDecision, mood);

  if (!state) {
    return {
      ...decision,
      action: "reply",
      effectiveMood: mood,
      policyReason: "no canonical interaction state; defaulted to reply",
      state: null,
    };
  }

  if (mood === "annoyed") state.annoyedLatch = true;
  if (decision.repair_signal) state.annoyedLatch = false;

  const effectiveMood = state.annoyedLatch ? "annoyed" : mood;
  let action = decision.action;
  let reaction = decision.reaction || fallbackReaction(effectiveMood);
  let policyReason = "accepted system decision";

  if (decision.reply_required || decision.importance === "high") {
    action = "reply";
    policyReason = "reply required by system decision";
  } else if (action === "silent" && !decision.silence_safe && effectiveMood !== "annoyed") {
    action = "reply";
    policyReason = "silence rejected outside an annoyed or explicitly safe context";
  }

  const previous = lastAction(state);
  const recentNonText = recentNonTextCount(state);

  if (action === "react" && effectiveMood !== "annoyed") {
    if (previous?.action === "react") {
      action = "reply";
      policyReason = "prevented consecutive reaction-only responses";
    } else if (recentNonText >= 2) {
      action = "reply";
      policyReason = "reaction budget reached; preserved text replies";
    }
  }

  if (action === "silent" && effectiveMood !== "annoyed" && recentNonText >= 2) {
    action = "reply";
    policyReason = "non-text budget reached; preserved text replies";
  }

  if (effectiveMood === "annoyed") {
    if (action === "react") {
      reaction = REACTION_EMOJIS.includes(decision.reaction) ? decision.reaction : "😒";
      if (state.consecutiveReactions >= 4) {
        action = "silent";
        policyReason = "annoyed reaction streak capped; switched to silence";
      }
    }
  }

  return {
    ...decision,
    action,
    reaction,
    effectiveMood,
    policyReason,
    state,
  };
}

async function recordResponseAction(personId, outcome, state = null) {
  if (!personId) return;
  const current = state || await loadInteractionState(personId);
  if (!current) return;

  const entry = {
    at: Date.now(),
    action: RESPONSE_ACTIONS.includes(outcome?.action) ? outcome.action : "reply",
    reaction: outcome?.action === "react" && REACTION_EMOJIS.includes(outcome?.reaction)
      ? outcome.reaction
      : null,
    mood: outcome?.mood || null,
    reason: typeof outcome?.reason === "string" ? outcome.reason.slice(0, 180) : null,
  };

  current.recentActions = [...(current.recentActions || []), entry].slice(-8);
  current.consecutiveReactions = entry.action === "react"
    ? (current.consecutiveReactions || 0) + 1
    : 0;
  current.lastActionAt = entry.at;
  await saveInteractionState(current);
}

async function recordNonTextMemory(chatId, text, name, action, reaction = null) {
  const loaded = await loadMemory(chatId);
  let memory = Array.isArray(loaded) ? loaded.slice() : [];
  const safeName = String(name || "User").slice(0, 80);
  const safeText = String(text || "").replace(/@\d{5,}/g, "@someone");

  memory.push({ role: "user", content: `${safeName}: ${safeText}` });
  memory.push({
    role: "assistant",
    content: action === "react"
      ? `[Nonverbal WhatsApp action: reacted ${reaction || "👍"} to the previous message]`
      : "[Nonverbal WhatsApp action: chose not to send a text reply]",
  });

  if (memory.length > MEMORY_LIMIT) memory = memory.slice(-MEMORY_LIMIT);
  await saveMemory(chatId, memory);
  return memory;
}

function publicInteractionState(state) {
  if (!state) return null;
  return {
    annoyedLatch: Boolean(state.annoyedLatch),
    recentActions: (state.recentActions || []).slice(-5),
    consecutiveReactions: state.consecutiveReactions || 0,
    lastActionAt: state.lastActionAt || null,
  };
}

module.exports = {
  RESPONSE_ACTIONS,
  RESPONSE_IMPORTANCE,
  REACTION_EMOJIS,
  loadInteractionState,
  resolveResponseAction,
  recordResponseAction,
  recordNonTextMemory,
  publicInteractionState,
};
