"use strict";

const crypto = require("crypto");
const {
  decisionGroqClient,
  DECISION_MODEL,
  VALID_MOODS,
} = require("../config");
const {
  appendGroqCall,
  finishGroqCall,
  updateDebugTrace,
} = require("../state");
const { loadMemory } = require("../storage");
const {
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_GRAPH,
} = require("../relationship/service");
const {
  REACTION_EMOJIS,
  publicInteractionState,
} = require("../interaction/service");

function sanitizeInternalMentions(value) {
  return typeof value === "string" ? value.replace(/@\d{5,}/g, "@someone") : value;
}

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
    response_format: request?.response_format ?? null,
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

async function tracedDecisionCall({ client, request, traceId }) {
  const callId = crypto.randomUUID();
  const startedAt = Date.now();

  appendGroqCall(traceId, {
    id: callId,
    purpose: "system-decision",
    clientNumber: 4,
    model: request.model,
    startedAt,
    status: "pending",
    request: requestSnapshot(request),
  });

  try {
    const completion = await createWithTimeout(client, request);
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

function defaultResponseDecision(reason) {
  return {
    action: "reply",
    reaction: null,
    reply_required: true,
    importance: "normal",
    silence_safe: false,
    repair_signal: false,
    reason,
  };
}

function parseJsonObject(raw) {
  const text = String(raw || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();
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

function sanitizeRecentMemory(memory) {
  return (Array.isArray(memory) ? memory : []).slice(-10).map((entry) => ({
    role: entry?.role,
    content: sanitizeInternalMentions(String(entry?.content || "").slice(0, 900)),
  }));
}

function normalizeResponse(raw) {
  const response = raw && typeof raw === "object" ? { ...raw } : {};
  if (!["reply", "react", "silent"].includes(response.action)) response.action = "reply";
  if (!["low", "normal", "high"].includes(response.importance)) response.importance = "normal";
  if (response.action === "react" && !REACTION_EMOJIS.includes(response.reaction)) response.reaction = null;
  if (response.action !== "react") response.reaction = null;
  response.reply_required = Boolean(response.reply_required);
  response.silence_safe = Boolean(response.silence_safe);
  response.repair_signal = Boolean(response.repair_signal);
  response.reason = typeof response.reason === "string" ? response.reason.slice(0, 240) : "";
  return response;
}

async function evaluateSystemDecision({
  chatId,
  text,
  name,
  relationship,
  interactionState,
  traceId = null,
}) {
  const currentStatus = RELATIONSHIP_STATUSES.includes(relationship?.status)
    ? relationship.status
    : "stranger";
  const fallback = {
    mood: "neutral",
    relationship: zeroRelationshipDecision(currentStatus, "system decision unavailable"),
    response: defaultResponseDecision("system decision unavailable"),
  };

  if (!decisionGroqClient) {
    updateDebugTrace(traceId, {
      mood: { input: text, result: "neutral", reason: "GROQ_API_KEY_4 is not configured" },
      systemDecision: { result: fallback, reason: "GROQ_API_KEY_4 is not configured" },
    });
    return fallback;
  }

  const loadedMemory = chatId ? await loadMemory(chatId) : [];
  const recentConversation = sanitizeRecentMemory(loadedMemory);
  const allowedNext = [currentStatus, ...(RELATIONSHIP_GRAPH[currentStatus] || [])];
  const publicInteraction = publicInteractionState(interactionState);

  const request = {
    model: DECISION_MODEL,
    temperature: 0.2,
    max_tokens: 500,
    reasoning_effort: "low",
    include_reasoning: false,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are Aveline's private SYSTEM DECISION BRAIN. You do not write the conversational reply.
You make three judgments for the latest user message:
1. immediate mood,
2. slow persistent relationship development,
3. whether Aveline should send a text reply, react to the WhatsApp message, or intentionally stay silent.

Return ONLY one raw JSON object with exactly this shape:
{"mood":"neutral","relationship":{"recommended_status":"stranger","change_strength":"none","confidence":0.8,"deltas":{"familiarity":0,"trust":0,"affection":0,"respect":0,"hostility":0},"reason":"brief relationship reason"},"response":{"action":"reply","reaction":null,"reply_required":true,"importance":"normal","silence_safe":false,"repair_signal":false,"reason":"brief delivery reason"}}

Mood MUST be one of: ${VALID_MOODS.join(", ")}.
Relationship status MUST be one of: ${RELATIONSHIP_STATUSES.join(", ")}.
change_strength MUST be one of: none, minor, significant, major.
confidence MUST be a number from 0 to 1.
Each relationship delta MUST be an integer from -12 to 12.
Response action MUST be one of: reply, react, silent.
Response importance MUST be one of: low, normal, high.
A reaction MUST be null unless action is react, otherwise choose exactly ONE emoji from: ${REACTION_EMOJIS.join(" ")}.

STRICT RELATIONSHIP RULES:
- Mood is fast and may change on one message.
- Relationship is deliberately slow and persistent. Never promote or demote it merely because one ordinary message is nice, rude, flirty, dry, or annoying.
- Normal conversation usually uses change_strength minor or none. Familiarity can creep upward slowly through repeated interaction.
- significant means meaningful evidence affecting lasting trust, affection, respect, hostility, or closeness.
- major is reserved for genuinely heavy events such as severe betrayal/abuse, major reconciliation, explicit deep trust, or sustained mutual romantic commitment.
- One insult may make mood annoyed without making the person an enemy.
- One compliment or heart emoji may make mood happy/affectionate without creating intimacy.
- Romantic states require clear repeated reciprocal context.
- Negative states require repeated harmful patterns or unusually severe evidence.
- Recommend the CURRENT relationship status unless there is real evidence for a transition.
- Recommend only the current status or one of the supplied allowed next statuses.
- Keep ordinary deltas small.

STRICT RESPONSE-MODE RULES:
- REPLY is the default. Aveline's text replies, jokes, comebacks and warmth are valuable; do not replace them casually.
- Use REACT only when a normal human could naturally acknowledge the message with one WhatsApp reaction and nothing useful would be lost.
- Good REACT candidates include: a standalone punchline/joke that needs no follow-up, a tiny acknowledgement, a lightweight compliment, an emoji-only message, a repeated farewell after Aveline has already said goodbye, or a low-effort poke while she is annoyed.
- Never use REACT instead of a substantive answer to a direct question, request, serious topic, personal disclosure, emotional support need, apology/reconciliation, meaningful new information, or a message that clearly deserves a comeback.
- Set reply_required=true whenever failing to answer would feel evasive, confusing, cold in the wrong way, or would skip something important.
- SILENT is rarer than REACT. Use it only when saying nothing is itself natural: repeated low-value pokes during sustained annoyance, or a conversation closure that has already been acknowledged. Set silence_safe=true only in those cases.
- If Aveline is annoyed and the user keeps sending trivial one-word pokes or bait, prefer 😒, 🙄, 😐, or occasional silence instead of manufacturing a fresh comeback every turn.
- If the annoyed person genuinely apologizes, reconciles, explains themselves seriously, or addresses the conflict meaningfully, set repair_signal=true and usually reply.
- repair_signal must NOT be true merely because the latest message is neutral or changes topic.
- If recent history shows Aveline already acknowledged a goodbye and the user sends another goodbye/later/night, prefer 👋 or silence instead of starting a farewell loop.
- For jokes, prefer 😂, 😭 or 💀 only when the joke actually lands in context.
- Keep reaction-only behavior selective. When uncertain, choose reply.
- reason fields must be short and concrete.

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
          recent_response_behavior: publicInteraction,
          recent_conversation: recentConversation,
          latest_message: sanitizeInternalMentions(text),
        }),
      },
    ],
  };

  try {
    const completion = await tracedDecisionCall({
      client: decisionGroqClient,
      request,
      traceId,
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

    const response = normalizeResponse(parsed?.response);
    const result = { mood, relationship: relation, response };

    updateDebugTrace(traceId, {
      mood: { input: text, rawOutput, result: mood },
      systemDecision: {
        input: {
          currentRelationship: currentStatus,
          allowedNext,
          recentConversationCount: recentConversation.length,
          recentResponseBehavior: publicInteraction,
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

module.exports = { evaluateSystemDecision };
