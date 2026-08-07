"use strict";

const {
  RELATIONSHIP_STATUSES,
  defaultRelationship,
  loadRelationship,
  saveRelationship,
  publicRelationship,
} = require("./service");

const METRIC_KEYS = ["familiarity", "trust", "affection", "respect", "hostility"];

function assertPersonId(personId) {
  if (typeof personId !== "string" || !/^person_[0-9a-f-]+$/i.test(personId)) {
    const error = new Error("A canonical person ID is required");
    error.status = 400;
    throw error;
  }
}

function clampMetric(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    const error = new Error("Relationship metrics must be numeric");
    error.status = 400;
    throw error;
  }
  return Math.max(0, Math.min(100, Math.round(number)));
}

async function updateRelationshipAdmin(personId, patch = {}) {
  assertPersonId(personId);
  let state = await loadRelationship(personId);
  const now = Date.now();

  if (patch.reset === true) {
    state = defaultRelationship(personId);
    await saveRelationship(state);
    return publicRelationship(state);
  }

  if (patch.status !== undefined) {
    if (!RELATIONSHIP_STATUSES.includes(patch.status)) {
      const error = new Error("Invalid relationship status");
      error.status = 400;
      throw error;
    }
    if (patch.status !== state.status) {
      state.status = patch.status;
      state.lastChangedAt = now;
      state.pendingTransition = null;
    }
  }

  if (patch.metrics !== undefined) {
    if (!patch.metrics || typeof patch.metrics !== "object" || Array.isArray(patch.metrics)) {
      const error = new Error("metrics must be an object");
      error.status = 400;
      throw error;
    }
    const metrics = { ...state.metrics };
    for (const key of METRIC_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch.metrics, key)) {
        metrics[key] = clampMetric(patch.metrics[key]);
      }
    }
    state.metrics = metrics;
  }

  if (patch.clearPending === true) state.pendingTransition = null;

  state.adminUpdatedAt = now;
  await saveRelationship(state);
  return publicRelationship(state);
}

module.exports = {
  METRIC_KEYS,
  updateRelationshipAdmin,
};
