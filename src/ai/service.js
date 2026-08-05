"use strict";

const { groqClients, MEMORY_LIMIT, MODELS, VALID_MOODS } = require("../config");
const { stats } = require("../state");
const { loadMemory, saveMemory, saveStats } = require("../storage");
const { buildSystemPrompt } = require("./prompt");

async function detectMood(text) {
  if (!groqClients.length) return "neutral";

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

    const parsed = JSON.parse(completion.choices[0].message.content.trim());
    return VALID_MOODS.includes(parsed.mood) ? parsed.mood : "neutral";
  } catch {
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

async function callAI(messages) {
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
        return completion.choices[0].message.content.trim();
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
  return "Whoa 😅 I'm a bit overloaded right now, try again in a moment.";
}

async function getAIReply(chatId, text, name, mood) {
  let memory = await loadMemory(chatId);
  memory.push({ role: "user", content: `${name}: ${text}` });
  if (memory.length > MEMORY_LIMIT) memory = memory.slice(-MEMORY_LIMIT);

  const reply = await callAI([
    { role: "system", content: buildSystemPrompt(mood) },
    ...memory,
  ]);

  memory.push({ role: "assistant", content: reply });
  await saveMemory(chatId, memory);
  return reply;
}

module.exports = { detectMood, callAI, getAIReply };
