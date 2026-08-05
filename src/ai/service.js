"use strict";

const { groqClients, MEMORY_LIMIT, MODELS, VALID_MOODS } = require("../config");
const { stats, mutateDebugTrace, updateDebugTrace } = require("../state");
const { loadMemory, saveMemory, saveStats } = require("../storage");
const { buildSystemPrompt } = require("./prompt");

async function detectMood(text, traceId = null) {
  if (!groqClients.length) {
    updateDebugTrace(traceId, { mood: { input: text, result: "neutral", reason: "no Groq clients" } });
    return "neutral";
  }

  try {
    const completion = await groqClients[0].chat.completions.create({
      model: MODELS[0],
      messages: [
        {
          role: "system",
          content: `Analyze the message and return ONLY a raw JSON object with:
- "mood": one of "happy", "neutral", "teasing", "annoyed", "affectionate"

Example: {"mood":"happy"}
Return ONLY the JSON. No markdown, no extra text.`,
        },
        { role: "user", content: text },
      ],
      max_tokens: 15,
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

async function callAI(messages, traceId = null) {
  for (const model of MODELS) {
    for (let keyIndex = 0; keyIndex < groqClients.length; keyIndex++) {
      const client = groqClients[keyIndex];
      try {
        console.log(`[AI] Trying key ${keyIndex + 1} / model: ${model}`);
        const completion = await createWithTimeout(client, {
          model,
          messages,
          max_tokens: 300,
          temperature: 0.85,
        });

        stats.modelUsage[model] = (stats.modelUsage[model] || 0) + 1;
        stats.keyUsage[`key${keyIndex + 1}`] = (stats.keyUsage[`key${keyIndex + 1}`] || 0) + 1;
        console.log(`[AI] Response from key ${keyIndex + 1} / model: ${model}`);

        const output = completion.choices[0].message.content.trim();
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

async function getAIReply(chatId, text, name, mood, traceId = null) {
  let memory = await loadMemory(chatId);
  const memoryBefore = memory.slice();
  memory.push({ role: "user", content: `${name}: ${text}` });
  if (memory.length > MEMORY_LIMIT) memory = memory.slice(-MEMORY_LIMIT);

  const messagesBeforeIdentityInjection = [
    { role: "system", content: buildSystemPrompt(mood) },
    ...memory,
  ];

  mutateDebugTrace(traceId, (trace) => {
    trace.ai = {
      chatId,
      speakerName: name,
      parsedText: text,
      mood,
      memoryBefore,
      messagesBeforeIdentityInjection,
      note: "The exact request after identity injection is recorded in Groq Calls.",
    };
  });

  const reply = await callAI(messagesBeforeIdentityInjection, traceId);

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
