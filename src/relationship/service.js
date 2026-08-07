"use strict";

const { redis } = require("../config");

const RELATIONSHIP_STATUSES = [
  "stranger",
  "acquaintance",
  "familiar",
  "respected",
  "friend",
  "close_friend",
  "best_friend",
  "confidant",
  "protective",
  "friendly_rival",
  "rival",
  "flirty",
  "crush",
  "romantic_interest",
  "partner",
  "distant_friend",
  "cautious",
  "distrustful",
  "uneasy",
  "disappointed",
  "disliked",
  "avoided",
  "hostile",
  "enemy",
  "estranged",
];

const RELATIONSHIP_GRAPH = {
  stranger: ["acquaintance", "cautious", "uneasy"],
  acquaintance: ["stranger", "familiar", "respected", "cautious", "uneasy", "disliked"],
  familiar: ["acquaintance", "respected", "friend", "friendly_rival", "flirty", "cautious", "distrustful", "disliked"],
  respected: ["familiar", "friend", "friendly_rival", "cautious", "disappointed"],
  friend: ["familiar", "respected", "close_friend", "confidant", "protective", "friendly_rival", "flirty", "distant_friend", "disappointed", "distrustful"],
  close_friend: ["friend", "best_friend", "confidant", "protective", "flirty", "distant_friend", "disappointed", "distrustful", "estranged"],
  best_friend: ["close_friend", "confidant", "protective", "distant_friend", "disappointed", "distrustful", "estranged"],
  confidant: ["close_friend", "best_friend", "protective", "distant_friend", "disappointed", "distrustful", "estranged"],
  protective: ["friend", "close_friend", "best_friend", "confidant", "distant_friend", "disappointed", "distrustful"],
  friendly_rival: ["familiar", "respected", "friend", "rival", "flirty", "distant_friend"],
  rival: ["friendly_rival", "cautious", "distrustful", "disliked", "hostile"],
  flirty: ["familiar", "friend", "friendly_rival", "crush", "distant_friend", "disappointed"],
  crush: ["flirty", "romantic_interest", "friend", "distant_friend", "disappointed", "distrustful"],
  romantic_interest: ["crush", "partner", "friend", "distant_friend", "disappointed", "distrustful", "estranged"],
  partner: ["romantic_interest", "close_friend", "distant_friend", "disappointed", "distrustful", "estranged"],
  distant_friend: ["familiar", "friend", "close_friend", "flirty", "cautious", "disappointed", "estranged"],
  cautious: ["stranger", "acquaintance", "familiar", "distrustful", "uneasy", "disliked"],
  distrustful: ["cautious", "familiar", "friend", "disappointed", "disliked", "avoided", "hostile", "estranged"],
  uneasy: ["stranger", "acquaintance", "cautious", "disliked", "avoided"],
  disappointed: ["friend", "close_friend", "distant_friend", "distrustful", "disliked", "estranged"],
  disliked: ["acquaintance", "cautious", "distrustful", "avoided", "hostile"],
  avoided: ["cautious", "distrustful", "disliked", "hostile", "estranged"],
  hostile: ["distrustful", "disliked", "avoided", "enemy", "rival"],
  enemy: ["hostile", "rival", "avoided"],
  estranged: ["distant_friend", "distrustful", "avoided", "friend"],
};

const DEFAULT_METRICS = {
  familiarity: 0,
  trust: 35,
  affection: 35,
  respect: 50,
  hostility: 0,
};

const CHANGE_WEIGHTS = {
  none: 0,
  minor: 1,
  significant: 2,
  major: 4,
};

const DELTA_CAPS = {
  none: 0,
  minor: 2,
  significant: 5,
  major: 12,
};

function relationshipKey(personId) {
  return `relationship:${personId}`;
}

function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function cleanText(value, limit = 180) {
  return typeof value === "string"
    ? value.replace(/[\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim().slice(0, limit)
    : "";
}

function defaultRelationship(personId) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    personId,
    status: "stranger",
    metrics: { ...DEFAULT_METRICS },
    interactionCount: 0,
    pendingTransition: null,
    recentEvidence: [],
    lastChangedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeRelationship(value, personId) {
  const base = defaultRelationship(personId);
  if (!value || typeof value !== "object") return base;

  const status = RELATIONSHIP_STATUSES.includes(value.status) ? value.status : "stranger";
  const metrics = {
    familiarity: clamp(value.metrics?.familiarity ?? DEFAULT_METRICS.familiarity),
    trust: clamp(value.metrics?.trust ?? DEFAULT_METRICS.trust),
    affection: clamp(value.metrics?.affection ?? DEFAULT_METRICS.affection),
    respect: clamp(value.metrics?.respect ?? DEFAULT_METRICS.respect),
    hostility: clamp(value.metrics?.hostility ?? DEFAULT_METRICS.hostility),
  };

  const pending = value.pendingTransition && RELATIONSHIP_STATUSES.includes(value.pendingTransition.target)
    ? {
        target: value.pendingTransition.target,
        evidence: Math.max(0, Number(value.pendingTransition.evidence) || 0),
        firstSeenAt: Number(value.pendingTransition.firstSeenAt) || Date.now(),
        lastSeenAt: Number(value.pendingTransition.lastSeenAt) || Date.now(),
        reason: cleanText(value.pendingTransition.reason),
      }
    : null;

  return {
    ...base,
    ...value,
    personId,
    status,
    metrics,
    interactionCount: Math.max(0, Number(value.interactionCount) || 0),
    pendingTransition: pending,
    recentEvidence: Array.isArray(value.recentEvidence) ? value.recentEvidence.slice(-8) : [],
    lastChangedAt: Number(value.lastChangedAt) || null,
    createdAt: Number(value.createdAt) || base.createdAt,
    updatedAt: Number(value.updatedAt) || base.updatedAt,
  };
}

async function loadRelationship(personId) {
  if (!personId) return null;
  try {
    const saved = await redis.get(relationshipKey(personId));
    return normalizeRelationship(saved, personId);
  } catch (error) {
    console.error(`[relationship] Failed to load ${personId}:`, error.message);
    return defaultRelationship(personId);
  }
}

async function saveRelationship(state) {
  if (!state?.personId) return;
  state.updatedAt = Date.now();
  try {
    await redis.set(relationshipKey(state.personId), state);
  } catch (error) {
    console.error(`[relationship] Failed to save ${state.personId}:`, error.message);
  }
}

function validStatus(value) {
  return RELATIONSHIP_STATUSES.includes(value);
}

function allowedTargets(status) {
  return RELATIONSHIP_GRAPH[status] || [];
}

function transitionThreshold(from, to) {
  const key = `${from}->${to}`;
  const special = {
    "stranger->acquaintance": 3,
    "acquaintance->familiar": 4,
    "familiar->friend": 5,
    "friend->close_friend": 6,
    "close_friend->best_friend": 7,
    "close_friend->confidant": 6,
    "friend->confidant": 7,
    "flirty->crush": 6,
    "crush->romantic_interest": 7,
    "romantic_interest->partner": 8,
    "hostile->enemy": 7,
    "enemy->hostile": 5,
  };
  if (special[key]) return special[key];

  if (["distrustful", "disliked", "avoided", "hostile", "estranged"].includes(to)) return 4;
  if (["enemy", "best_friend", "partner"].includes(to)) return 7;
  return 5;
}

function metricsAllow(target, metrics) {
  const m = metrics;
  const rules = {
    acquaintance: () => m.familiarity >= 5,
    familiar: () => m.familiarity >= 18,
    respected: () => m.respect >= 65 && m.hostility <= 30,
    friend: () => m.familiarity >= 32 && m.trust >= 38 && m.affection >= 38 && m.hostility <= 25,
    close_friend: () => m.familiarity >= 55 && m.trust >= 52 && m.affection >= 52 && m.hostility <= 20,
    best_friend: () => m.familiarity >= 75 && m.trust >= 70 && m.affection >= 70 && m.hostility <= 15,
    confidant: () => m.familiarity >= 55 && m.trust >= 70 && m.hostility <= 20,
    protective: () => m.affection >= 62 && m.trust >= 50 && m.hostility <= 20,
    friendly_rival: () => m.familiarity >= 30 && m.respect >= 50 && m.hostility <= 40,
    rival: () => m.familiarity >= 25 && (m.hostility >= 20 || m.respect >= 55),
    flirty: () => m.familiarity >= 20 && m.affection >= 45 && m.hostility <= 20,
    crush: () => m.familiarity >= 35 && m.affection >= 62 && m.hostility <= 15,
    romantic_interest: () => m.familiarity >= 50 && m.affection >= 72 && m.trust >= 48 && m.hostility <= 15,
    partner: () => m.familiarity >= 70 && m.affection >= 82 && m.trust >= 70 && m.hostility <= 10,
    distant_friend: () => m.familiarity >= 30,
    cautious: () => m.trust <= 45 || m.hostility >= 15,
    distrustful: () => m.trust <= 30 || m.hostility >= 30,
    uneasy: () => m.trust <= 38 || m.hostility >= 20,
    disappointed: () => m.familiarity >= 25 && (m.trust <= 42 || m.respect <= 42),
    disliked: () => m.affection <= 28 || m.hostility >= 35,
    avoided: () => m.trust <= 22 || m.hostility >= 45,
    hostile: () => m.hostility >= 60,
    enemy: () => m.hostility >= 78,
    estranged: () => m.familiarity >= 45 && (m.trust <= 28 || m.affection <= 28),
    stranger: () => m.familiarity <= 15,
  };
  return rules[target] ? Boolean(rules[target]()) : true;
}

function normalizeStrength(value) {
  return Object.prototype.hasOwnProperty.call(CHANGE_WEIGHTS, value) ? value : "none";
}

function normalizeConfidence(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0;
}

function normalizeDeltas(raw, strength) {
  const cap = DELTA_CAPS[strength];
  const result = {};
  for (const metric of Object.keys(DEFAULT_METRICS)) {
    const value = Number(raw?.[metric]);
    result[metric] = Number.isFinite(value) ? Math.max(-cap, Math.min(cap, Math.round(value))) : 0;
  }
  return result;
}

function applyMetricDeltas(metrics, deltas) {
  const next = { ...metrics };
  for (const metric of Object.keys(DEFAULT_METRICS)) {
    next[metric] = clamp((next[metric] || 0) + (deltas[metric] || 0));
  }
  return next;
}

function decayPending(state) {
  if (!state.pendingTransition) return;
  state.pendingTransition.evidence = Math.max(0, state.pendingTransition.evidence - 1);
  if (!state.pendingTransition.evidence) state.pendingTransition = null;
}

async function applyRelationshipDecision(personId, rawDecision = {}) {
  if (!personId) return { state: null, transition: null, applied: false };

  const state = await loadRelationship(personId);
  const now = Date.now();
  const strength = normalizeStrength(rawDecision.change_strength);
  const confidence = normalizeConfidence(rawDecision.confidence);
  const deltas = normalizeDeltas(rawDecision.deltas, strength);
  const recommendation = validStatus(rawDecision.recommended_status)
    ? rawDecision.recommended_status
    : state.status;
  const reason = cleanText(rawDecision.reason || rawDecision.evidence_summary || "");

  state.interactionCount += 1;
  state.metrics = applyMetricDeltas(state.metrics, deltas);

  const evidence = {
    at: now,
    fromStatus: state.status,
    recommendedStatus: recommendation,
    strength,
    confidence,
    deltas,
    reason,
  };
  state.recentEvidence = [...(state.recentEvidence || []), evidence].slice(-8);

  let transition = null;
  const allowed = recommendation !== state.status && allowedTargets(state.status).includes(recommendation);
  const gated = allowed && metricsAllow(recommendation, state.metrics);

  if (!allowed || !gated || strength === "none" || confidence < 0.55) {
    decayPending(state);
  } else {
    const weight = CHANGE_WEIGHTS[strength] + (confidence >= 0.9 ? 1 : 0);

    if (state.pendingTransition?.target === recommendation) {
      state.pendingTransition.evidence += weight;
      state.pendingTransition.lastSeenAt = now;
      state.pendingTransition.reason = reason || state.pendingTransition.reason;
    } else {
      state.pendingTransition = {
        target: recommendation,
        evidence: weight,
        firstSeenAt: now,
        lastSeenAt: now,
        reason,
      };
    }

    const threshold = transitionThreshold(state.status, recommendation);
    if (state.pendingTransition.evidence >= threshold) {
      const previousStatus = state.status;
      state.status = recommendation;
      state.lastChangedAt = now;
      transition = {
        from: previousStatus,
        to: recommendation,
        at: now,
        reason: state.pendingTransition.reason || reason,
        evidence: state.pendingTransition.evidence,
        threshold,
      };
      state.pendingTransition = null;
    }
  }

  await saveRelationship(state);
  return {
    state,
    transition,
    applied: true,
    evaluation: {
      recommendation,
      allowed,
      metricsGatePassed: gated,
      strength,
      confidence,
      deltas,
      reason,
    },
  };
}

function publicRelationship(state) {
  if (!state) return null;
  return {
    personId: state.personId,
    status: state.status,
    metrics: state.metrics,
    interactionCount: state.interactionCount,
    pendingTransition: state.pendingTransition,
    recentEvidence: state.recentEvidence,
    lastChangedAt: state.lastChangedAt,
    updatedAt: state.updatedAt,
  };
}

module.exports = {
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_GRAPH,
  defaultRelationship,
  loadRelationship,
  saveRelationship,
  applyRelationshipDecision,
  publicRelationship,
};
