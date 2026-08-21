"use strict";

const crypto = require("crypto");
const {
  groqKeySlots,
  decisionGroqClient,
  MEMORY_LIMIT,
  MODELS,
  VALID_MOODS,
} = require("../config");
const {
  stats,
  mutateDebugTrace,
  updateDebugTrace,
  appendGroqCall,
  finishGroqCall,
} = require("../state");
const { loadMemory, saveMemory, saveStats } = require("../storage");
const { buildSystemPrompt } = require("./prompt");
const {
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_GRAPH,
} = require("../relationship/service");
const {
  getPairEligibility,
  markPairFailure,
  markPairSuccess,
} = require("./router-health");

function safeError(error) {
  return {
    name: error?.name || "Error",
    message: String(error?.message || error || "Unknown error").slice(0, 2000),
    status: error?.status || null,
  };
}

function requestSnapshot(request) {
  return {
    model: request?.model || null,
    max_tokens: request?.max_tokens ?? null,
    temperature: request?.temperature ?? null,
    reasoning_effort: request?.reasoning_effort ?? null,
    include_reasoning: request?.include_reasoning ?? null,
    messages: Array.isArray(request?.messages)
      ? request.messages.map((message) => ({
          role: message?.role || null,
          content: typeof message?.content === "string"
            ? message.content.slice(0, 20000)
            : message?.content ?? null,
        }))
      : [],
  };
}

function sanitizeInternalMentions(value) {
  return typeof value === "string" ? value.replace(/@\d{5,}/g, "@someone") : value;
}

function sanitizeModelOutput(value) {
  let text = sanitizeInternalMentions(String(value || "").trim());

  // Defensive guard for reasoning-capable models. Normal Qwen chat requests run
  // with reasoning disabled, but never allow a tagged chain-of-thought block to
  // enter WhatsApp or conversational memory if a provider/model regresses.
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();

  if (/<think>/i.test(text) || /<\/think>/i.test(text)) {
    const error = new Error("reasoning_leak_blocked");
    error.code = "reasoning_leak_blocked";
    throw error;
  }

  if (!text) {
    const error = new Error("empty_model_output");
    error.code = "empty_model_output";
    throw error;
  }

  return text;
}

function sanitizeMemory(memory) {
  let changed = false;
  const sanitized = (Array.isArray(memory) ? memory : []).map((entry) => {
    const content = sanitizeInternalMentions(entry?.content);
    if (content !== entry?.content) changed = true;
    return { ...entry, content };
  });
  return { memory: sanitized, changed };
}

function injectIdentityPrompt(messages, identityPrompt) {
  if (!identityPrompt || !Array.isArray(messages)) return messages;
  return messages.map((message, index) => index === 0 && typeof message?.content === "string"
    ? { ...message, content: `${message.content}\n\n${identityPrompt}` }
    : message);
}

function appendRouterEvent(traceId, field, event) {
  mutateDebugTrace(traceId, (trace) => {
    trace.router = trace.router || { skipped: [], attempted: [], selected: null };
    trace.router[field] = Array.isArray(trace.router[field]) ? trace.router[field] : [];
    trace.router[field].push(event);
  });
}

async function createWithTimeout(client, request, timeoutMs = 4000) {
  let timeoutId;
  try {
    return await Promise.race([
      client.chat.completions.create(request),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function tracedGroqCall({
  client,
  clientNumber,
  request,
  traceId,
  purpose,
  timeoutMs = 4000,
}) {
  const callId = crypto.randomUUID();
  const startedAt = Date.now();

  appendGroqCall(traceId, {
    id: callId,
    purpose,
    clientNumber,
    model: request?.model || null,
    startedAt,
    status: "pending",
    request: requestSnapshot(request),
  });

  try {
    const completion = await createWithTimeout(client, request, timeoutMs);
    const output = completion?.choices?.[0]?.message?.content ?? null;
    finishGroqCall(traceId, callId, {
      status: "success",
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      output: typeof output === "string" ? output.slice(0, 20000) : output,
      finishReason: completion?.choices?.[0]?.finish_reason || null,
      usage: completion?.usage || null,
    });
    return completion;
  } catch (error) {
    finishGroqCall(traceId, callId, {
      status: "error",
      completedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      error: safeError(error),
    });
    throw error;
  }
}

function zeroRelationshipDecision(status, reason) {
  return {
    recommended_status: status || "stranger",
    change_strength: "none",
    confidence: 0,
    deltas: {
      familiarity: 0,
      trust: 0,
      affection: 0,
      respect: 0,
      hostility: 0,
    },
    reason,
  };
}

function parseJsonObject(raw) {
  const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("system decision returned no JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function compactRelationshipEvidence(relationship) {
  return (relationship?.recentEvidence || []).slice(-6).map((entry) => ({
    at: entry.at,
    fromStatus: entry.fromStatus,
    recommendedStatus: entry.recommendedStatus,
    strength: entry.strength,
    confidence: entry.confidence,
    reason: entry.reason,
  }));
}

async function evaluateSystemDecision({
  chatId,
  text,
  name,
  relationship,
  traceId = null,
}) {
  const currentStatus = RELATIONSHIP_STATUSES.includes(relationship?.status)
    ? relationship.status
    : "stranger";
  const fallback = {
    mood: "neutral",
    relationship: zeroRelationshipDecision(currentStatus, "system decision unavailable"),
  };

  if (!decisionGroqClient) {
    updateDebugTrace(traceId, {
      mood: { input: text, result: "neutral", reason: "GROQ_API_KEY_4 is not configured" },
      systemDecision: { result: fallback, reason: "GROQ_API_KEY_4 is not configured" },
    });
    return fallback;
  }

  const loadedMemory = chatId ? await loadMemory(chatId) : [];
  const recentConversation = sanitizeMemory(loadedMemory).memory.slice(-8).map((entry) => ({
    role: entry.role,
    content: String(entry.content || "").slice(0, 800),
  }));
  const allowedNext = [currentStatus, ...(RELATIONSHIP_GRAPH[currentStatus] || [])];

  const request = {
    model: MODELS[0],
    temperature: 0.2,
    max_tokens: 350,
    messages: [
      {
        role: "system",
        content: `You are Aveline's private SYSTEM DECISION BRAIN. You do not write the conversational reply.
Your job is to judge (1) Aveline's immediate mood toward the person and (2) slow relationship development.

Return ONLY one raw JSON object with exactly this shape:
{"mood":"neutral","relationship":{"recommended_status":"stranger","change_strength":"none","confidence":0.8,"deltas":{"familiarity":0,"trust":0,"affection":0,"respect":0,"hostility":0},"reason":"brief evidence-based reason"}}

Mood MUST be one of: ${VALID_MOODS.join(", ")}.
Relationship status MUST be one of: ${RELATIONSHIP_STATUSES.join(", ")}.
change_strength MUST be one of: none, minor, significant, major.
confidence MUST be a number from 0 to 1.
Each delta MUST be an integer from -12 to 12.

STRICT RELATIONSHIP RULES:
- Mood is fast and may change on a single message.
- Relationship is deliberately slow and persistent. NEVER promote or demote it merely because one ordinary message is nice, rude, flirty, dry, or annoying.
- Normal conversation usually uses change_strength minor or none. Familiarity can creep upward slowly through repeated interaction.
- significant means the conversation contains meaningful evidence that should influence lasting trust, affection, respect, hostility, or closeness.
- major is reserved for genuinely heavy events: severe betrayal/abuse, major reconciliation, explicit deeply personal trust, sustained mutual romantic commitment, or similarly decisive moments.
- A single insult can make mood annoyed without making someone an enemy.
- A single compliment or heart emoji can make mood happy/affectionate without making someone a close friend or romantic interest.
- Romantic states require clear repeated reciprocal context. "partner" requires established mutual relationship context, never mere flirting.
- Negative states require repeated harmful patterns or unusually severe evidence.
- Recommend the CURRENT status unless there is real evidence for a transition.
- You may recommend ONLY the current status or one of the allowed next statuses supplied in the input. Never jump across the graph.
- Deltas describe this interaction only. Keep them small for ordinary conversation.
- reason must be short, concrete, and about interaction evidence, not hidden policy.

Return JSON only. No markdown, commentary, or reply text.`,
      },
      {
        role: "user",
        content: JSON.stringify({
          person_name: name || "Unknown",
          current_relationship: {
            status: currentStatus,
            metrics: relationship?.metrics || null,
            interaction_count: relationship?.interactionCount || 0,
            pending_transition: relationship?.pendingTransition || null,
          },
          allowed_next_statuses: allowedNext,
          recent_relationship_evidence: compactRelationshipEvidence(relationship),
          recent_conversation: recentConversation,
          latest_message: sanitizeInternalMentions(text),
        }),
      },
    ],
  };

  try {
    const completion = await tracedGroqCall({
      client: decisionGroqClient,
      clientNumber: 4,
      request,
      traceId,
      purpose: "system-decision",
    });
    const rawOutput = completion.choices[0].message.content.trim();
    const parsed = parseJsonObject(rawOutput);
    const mood = VALID_MOODS.includes(parsed?.mood) ? parsed.mood : "neutral";
    const relation = parsed?.relationship && typeof parsed.relationship === "object"
      ? parsed.relationship
      : zeroRelationshipDecision(currentStatus, "invalid relationship decision payload");

    if (!allowedNext.includes(relation.recommended_status)) {
      relation.recommended_status = currentStatus;
      relation.change_strength = "none";
      relation.reason = "invalid graph transition rejected";
    }

    const result = { mood, relationship: relation };
    updateDebugTrace(traceId, {
      mood: { input: text, rawOutput, result: mood },
      systemDecision: {
        input: {
          currentRelationship: currentStatus,
          allowedNext,
          recentConversationCount: recentConversation.length,
        },
        rawOutput,
        result,
      },
    });
    return result;
  } catch (error) {
    updateDebugTrace(traceId, {
      mood: {
        input: text,
        result: "neutral",
        error: String(error?.message || error).slice(0, 2000),
      },
      systemDecision: {
        result: fallback,
        error: String(error?.message || error).slice(0, 2000),
      },
    });
    return fallback;
  }
}

async function detectMood(text, traceId = null) {
  const result = await evaluateSystemDecision({
    chatId: null,
    text,
    name: "Unknown",
    relationship: null,
    traceId,
  });
  return result.mood;
}

async function callAI(messages, traceId = null, identityPrompt = null) {
  const finalMessages = injectIdentityPrompt(messages, identityPrompt)
    .map((message) => ({ ...message, content: sanitizeInternalMentions(message.content) }));

  mutateDebugTrace(traceId, (trace) => {
    trace.router = {
      order: MODELS.map((model) => ({ model, keys: [1, 2, 3] })),
      skipped: [],
      attempted: [],
      selected: null,
    };
  });

  for (const model of MODELS) {
    for (const slot of groqKeySlots) {
      const { keyNumber, client } = slot;
      if (!client) {
        appendRouterEvent(traceId, "skipped", {
          keyNumber,
          model,
          reason: "not_configured",
          at: Date.now(),
        });
        continue;
      }

      const availability = await getPairEligibility(keyNumber, model);
      if (!availability.eligible) {
        appendRouterEvent(traceId, "skipped", {
          keyNumber,
          model,
          reason: availability.reason,
          remainingMs: availability.remainingMs,
          cooldownUntil: availability.state.cooldownUntil || null,
          at: Date.now(),
        });
        console.log(`[router] Skipping key ${keyNumber} / ${model}: ${availability.reason}`);
        continue;
      }

      const request = {
        model,
        messages: finalMessages,
        max_tokens: 300,
        temperature: 0.85,
        ...(model === "qwen/qwen3.6-27b"
          ? { reasoning_effort: "none", include_reasoning: false }
          : {}),
      };
      const attemptStartedAt = Date.now();

      try {
        console.log(`[AI] Trying key ${keyNumber} / model: ${model}`);
        const completion = await tracedGroqCall({
          client,
          clientNumber: keyNumber,
          request,
          traceId,
          purpose: "reply",
        });

        await markPairSuccess(keyNumber, model);
        appendRouterEvent(traceId, "attempted", {
          keyNumber,
          model,
          result: "success",
          durationMs: Date.now() - attemptStartedAt,
        });

        stats.modelUsage[model] = (stats.modelUsage[model] || 0) + 1;
        stats.keyUsage[`key${keyNumber}`] = (stats.keyUsage[`key${keyNumber}`] || 0) + 1;
        console.log(`[AI] Response from key ${keyNumber} / model: ${model}`);

        const output = sanitizeModelOutput(completion.choices[0].message.content);
        updateDebugTrace(traceId, {
          selectedGroqResult: {
            model,
            clientNumber: keyNumber,
            output,
          },
        });
        mutateDebugTrace(traceId, (trace) => {
          trace.router = trace.router || {};
          trace.router.selected = { keyNumber, model, at: Date.now() };
        });
        return output;
      } catch (error) {
        const failure = await markPairFailure(keyNumber, model, error);
        appendRouterEvent(traceId, "attempted", {
          keyNumber,
          model,
          result: "error",
          failureType: failure.type,
          reason: failure.reason,
          cooldownMs: failure.durationMs,
          durationMs: Date.now() - attemptStartedAt,
          error: safeError(error),
        });

        if (error?.status === 429) {
          stats.rateLimitHits++;
          console.log(`[AI] Key ${keyNumber} rate limited on ${model} → cooldown + next pair`);
        } else if (error.message === "timeout") {
          console.log(`[AI] Key ${keyNumber} timed out on ${model} → short cooldown + next pair`);
        } else if (error.message === "reasoning_leak_blocked") {
          console.log(`[AI] Blocked leaked reasoning from key ${keyNumber} / ${model}`);
        } else {
          console.log(`[AI] Key ${keyNumber} error on ${model}:`, error.message || error);
        }
      }
    }

    const nextModel = MODELS[MODELS.indexOf(model) + 1];
    if (nextModel) console.log(`[AI] No available success for ${model} → switching to ${nextModel}`);
  }

  await saveStats();
  const fallback = "Whoa 😅 I'm a bit overloaded right now, try again in a moment.";
  updateDebugTrace(traceId, {
    selectedGroqResult: {
      model: null,
      clientNumber: null,
      output: fallback,
      fallback: true,
    },
  });
  return fallback;
}

async function getAIReply(
  chatId,
  text,
  name,
  mood,
  relationship,
  traceId = null,
  identityPrompt = null
) {
  const loaded = await loadMemory(chatId);
  const sanitized = sanitizeMemory(loaded);
  let memory = sanitized.memory;
  if (sanitized.changed) await saveMemory(chatId, memory);

  const memoryBefore = memory.slice();
  const safeText = sanitizeInternalMentions(text);
  memory.push({ role: "user", content: `${name}: ${safeText}` });
  if (memory.length > MEMORY_LIMIT) memory = memory.slice(-MEMORY_LIMIT);

  const messagesBeforeIdentityInjection = [
    { role: "system", content: buildSystemPrompt(mood, relationship) },
    ...memory,
  ];

  mutateDebugTrace(traceId, (trace) => {
    trace.ai = {
      chatId,
      speakerName: name,
      parsedText: safeText,
      mood,
      relationship: relationship ? {
        status: relationship.status,
        metrics: relationship.metrics,
        interactionCount: relationship.interactionCount,
        pendingTransition: relationship.pendingTransition,
      } : null,
      memoryBefore,
      staleNumericMentionsRemoved: sanitized.changed,
      messagesBeforeIdentityInjection,
      identityPrompt,
      note: "The exact final request is recorded under Groq Calls.",
    };
  });

  const reply = await callAI(messagesBeforeIdentityInjection, traceId, identityPrompt);

  memory.push({ role: "assistant", content: reply });
  await saveMemory(chatId, memory);

  mutateDebugTrace(traceId, (trace) => {
    trace.ai = {
      ...(trace.ai || {}),
      memoryAfter: memory,
      finalOutput: reply,
    };
  });

  return reply;
}

module.exports = {
  evaluateSystemDecision,
  detectMood,
  callAI,
  getAIReply,
};