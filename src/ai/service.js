"use strict";

const crypto = require("crypto");
const {
  groqClients,
  moodGroqClient,
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

async function detectMood(text, traceId = null) {
  if (!moodGroqClient) {
    updateDebugTrace(traceId, {
      mood: { input: text, result: "neutral", reason: "GROQ_API_KEY_4 is not configured" },
    });
    return "neutral";
  }

  const request = {
    model: MODELS[0],
    messages: [
      {
        role: "system",
        content: `Analyze the message and return ONLY a raw JSON object with:
- "mood": one of "happy", "neutral", "teasing", "annoyed", "affectionate"

Example: {"mood":"happy"}
Return ONLY the JSON. No markdown, no extra text.`,
      },
      { role: "user", content: sanitizeInternalMentions(text) },
    ],
    max_tokens: 15,
  };

  try {
    const completion = await tracedGroqCall({
      client: moodGroqClient,
      clientNumber: 4,
      request,
      traceId,
      purpose: "mood",
    });
    const rawOutput = completion.choices[0].message.content.trim();
    const parsed = JSON.parse(rawOutput);
    const result = VALID_MOODS.includes(parsed.mood) ? parsed.mood : "neutral";
    updateDebugTrace(traceId, { mood: { input: text, rawOutput, result } });
    return result;
  } catch (error) {
    updateDebugTrace(traceId, {
      mood: {
        input: text,
        result: "neutral",
        error: String(error?.message || error).slice(0, 2000),
      },
    });
    return "neutral";
  }
}

async function callAI(messages, traceId = null, identityPrompt = null) {
  const finalMessages = injectIdentityPrompt(messages, identityPrompt)
    .map((message) => ({ ...message, content: sanitizeInternalMentions(message.content) }));

  for (const model of MODELS) {
    for (let keyIndex = 0; keyIndex < groqClients.length; keyIndex++) {
      const client = groqClients[keyIndex];
      const request = {
        model,
        messages: finalMessages,
        max_tokens: 300,
        temperature: 0.85,
      };

      try {
        console.log(`[AI] Trying key ${keyIndex + 1} / model: ${model}`);
        const completion = await tracedGroqCall({
          client,
          clientNumber: keyIndex + 1,
          request,
          traceId,
          purpose: "reply",
        });

        stats.modelUsage[model] = (stats.modelUsage[model] || 0) + 1;
        stats.keyUsage[`key${keyIndex + 1}`] = (stats.keyUsage[`key${keyIndex + 1}`] || 0) + 1;
        console.log(`[AI] Response from key ${keyIndex + 1} / model: ${model}`);

        const output = sanitizeInternalMentions(completion.choices[0].message.content.trim());
        updateDebugTrace(traceId, {
          selectedGroqResult: {
            model,
            clientNumber: keyIndex + 1,
            output,
          },
        });
        return output;
      } catch (error) {
        if (error?.status === 429) {
          stats.rateLimitHits++;
          console.log(`[AI] Key ${keyIndex + 1} rate limited on ${model} → trying next`);
        } else if (error.message === "timeout") {
          console.log(`[AI] Key ${keyIndex + 1} timed out on ${model} → trying next`);
        } else {
          console.log(`[AI] Key ${keyIndex + 1} error on ${model}:`, error.message || error);
        }
      }
    }

    const nextModel = MODELS[MODELS.indexOf(model) + 1];
    if (nextModel) console.log(`[AI] All keys exhausted for ${model} → switching to ${nextModel}`);
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

async function getAIReply(chatId, text, name, mood, traceId = null, identityPrompt = null) {
  const loaded = await loadMemory(chatId);
  const sanitized = sanitizeMemory(loaded);
  let memory = sanitized.memory;
  if (sanitized.changed) await saveMemory(chatId, memory);

  const memoryBefore = memory.slice();
  const safeText = sanitizeInternalMentions(text);
  memory.push({ role: "user", content: `${name}: ${safeText}` });
  if (memory.length > MEMORY_LIMIT) memory = memory.slice(-MEMORY_LIMIT);

  const messagesBeforeIdentityInjection = [
    { role: "system", content: buildSystemPrompt(mood) },
    ...memory,
  ];

  mutateDebugTrace(traceId, (trace) => {
    trace.ai = {
      chatId,
      speakerName: name,
      parsedText: safeText,
      mood,
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

module.exports = { detectMood, callAI, getAIReply };
