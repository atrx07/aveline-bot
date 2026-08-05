"use strict";

const { redis } = require("./config");
const { stats } = require("./state");

function splitMemberMoodScope(scope) {
  const marker = "@g.us:";
  const index = typeof scope === "string" ? scope.indexOf(marker) : -1;
  if (index < 0) return null;

  return {
    groupId: scope.slice(0, index + "@g.us".length),
    memberId: scope.slice(index + marker.length),
  };
}

async function loadMemory(chatId) {
  try {
    const data = await redis.get(`memory:${chatId}`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveMemory(chatId, memory) {
  try {
    await redis.set(`memory:${chatId}`, memory);
  } catch (error) {
    console.error("[redis] Failed to save memory:", error.message);
  }
}

async function loadMood(chatId) {
  try {
    const memberScope = splitMemberMoodScope(chatId);
    if (memberScope) {
      const { resolveIdentity } = require("./canonical-members");
      const identity = await resolveIdentity(memberScope.memberId);
      const canonicalId = identity.canonicalId || memberScope.memberId;
      const canonicalMood = await redis.get(`mood:${memberScope.groupId}:${canonicalId}`);
      if (canonicalMood) return canonicalMood;

      if (canonicalId !== memberScope.memberId) {
        const legacyMood = await redis.get(`mood:${chatId}`);
        if (legacyMood) {
          await redis.set(`mood:${memberScope.groupId}:${canonicalId}`, legacyMood).catch(() => {});
          return legacyMood;
        }
      }
      return "neutral";
    }

    return (await redis.get(`mood:${chatId}`)) || "neutral";
  } catch {
    return "neutral";
  }
}

async function saveMood(chatId, mood) {
  try {
    const memberScope = splitMemberMoodScope(chatId);
    if (memberScope) {
      const { resolveIdentity } = require("./canonical-members");
      const identity = await resolveIdentity(memberScope.memberId);
      const canonicalId = identity.canonicalId || memberScope.memberId;
      await redis.set(`mood:${memberScope.groupId}:${canonicalId}`, mood);
      return;
    }

    await redis.set(`mood:${chatId}`, mood);
  } catch (error) {
    console.error("[redis] Failed to save mood:", error.message);
  }
}

async function isStickerEnabled(chatId) {
  try {
    const value = await redis.get(`stickers:enabled:${chatId}`);
    return value === true || value === "true";
  } catch {
    return true;
  }
}

async function setStickerEnabled(chatId, enabled) {
  try {
    await redis.set(`stickers:enabled:${chatId}`, enabled);
  } catch {}
}

async function saveName(key, name) {
  try {
    const existing = await redis.get(`name:${key}`);
    if (!existing && name) await redis.set(`name:${key}`, name);
  } catch {}
}

async function saveGroupMember(groupId, userId, name, personHint = null) {
  try {
    const { saveCanonicalGroupMember } = require("./canonical-members");
    return await saveCanonicalGroupMember(groupId, userId, name, personHint);
  } catch (error) {
    console.error("[members] Canonical save failed, using legacy member ID:", error.message);
    try {
      if (name) await redis.set(`name:${groupId}:${userId}`, name);
      const existing = await redis.get(`members:${groupId}`);
      const members = Array.isArray(existing) ? existing : [];
      if (!members.includes(userId)) {
        members.push(userId);
        await redis.set(`members:${groupId}`, members);
      }
    } catch {}
    return userId;
  }
}

async function isBlacklisted(chatId) {
  try {
    const { isCanonicalBlacklisted } = require("./canonical-members");
    return await isCanonicalBlacklisted(chatId);
  } catch {
    try {
      const value = await redis.get(`blacklist:${chatId}`);
      return value === true || value === "true";
    } catch {
      return false;
    }
  }
}

async function toggleBlacklist(chatId) {
  try {
    const { toggleCanonicalBlacklist } = require("./canonical-members");
    return await toggleCanonicalBlacklist(chatId);
  } catch {
    const current = await isBlacklisted(chatId);
    if (current) await redis.del(`blacklist:${chatId}`);
    else await redis.set(`blacklist:${chatId}`, true);
    return !current;
  }
}

async function getAllChatIds() {
  try {
    const keys = await redis.keys("memory:*");
    return keys.map((key) => key.replace("memory:", ""));
  } catch {
    return [];
  }
}

async function loadStats() {
  try {
    const saved = await redis.get("stats:total");
    if (!saved) return;
    stats.totalMessages = saved.totalMessages || 0;
    stats.modelUsage = saved.modelUsage || {};
    stats.keyUsage = saved.keyUsage || {};
    stats.rateLimitHits = saved.rateLimitHits || 0;
  } catch {}
}

async function saveStats() {
  try {
    await redis.set("stats:total", {
      totalMessages: stats.totalMessages,
      modelUsage: stats.modelUsage,
      keyUsage: stats.keyUsage,
      rateLimitHits: stats.rateLimitHits,
    });
  } catch {}
}

async function purgeAllMemory() {
  const [memoryKeys, moodKeys] = await Promise.all([
    redis.keys("memory:*").catch(() => []),
    redis.keys("mood:*").catch(() => []),
  ]);
  const keys = [...memoryKeys, ...moodKeys];
  await Promise.all(keys.map((key) => redis.del(key)));
  return memoryKeys.length;
}

async function purgeChatMemory(chatId) {
  const memberMoodKeys = await redis.keys(`mood:${chatId}:*`).catch(() => []);
  await Promise.all([
    redis.del(`memory:${chatId}`),
    redis.del(`mood:${chatId}`),
    ...memberMoodKeys.map((key) => redis.del(key)),
  ]);
}

async function listChats() {
  const chatIds = await getAllChatIds();
  return Promise.all(chatIds.map(async (id) => {
    const isGroup = id.endsWith("@g.us");
    const [memory, mood, blacklisted, name, stickerEnabled] = await Promise.all([
      loadMemory(id),
      loadMood(id),
      isBlacklisted(id),
      redis.get(`name:${id}`).catch(() => null),
      isStickerEnabled(id),
    ]);

    if (!isGroup) {
      return {
        id,
        isGroup: false,
        name: name || null,
        messageCount: memory.length,
        mood,
        blacklisted,
        stickerEnabled,
        members: [],
      };
    }

    const memberIds = await redis.get(`members:${id}`).catch(() => []);
    const members = await Promise.all((Array.isArray(memberIds) ? memberIds : []).map(async (userId) => {
      const [memberName, memberMood, memberBlacklisted] = await Promise.all([
        redis.get(`name:${id}:${userId}`).catch(() => null),
        loadMood(`${id}:${userId}`),
        isBlacklisted(userId),
      ]);
      return {
        id: userId,
        name: memberName || userId.split("@")[0],
        mood: memberMood,
        blacklisted: memberBlacklisted,
      };
    }));

    return {
      id,
      isGroup: true,
      name: name || null,
      messageCount: memory.length,
      mood,
      blacklisted,
      stickerEnabled,
      members,
    };
  }));
}

async function saveStandbySticker(id, data) {
  try {
    await redis.set(`sticker:standby:${id}`, data);
  } catch {}
}

async function getStandbyStickers() {
  try {
    const keys = await redis.keys("sticker:standby:*");
    const stickers = await Promise.all(keys.map(async (key) => ({
      id: key.replace("sticker:standby:", ""),
      ...(await redis.get(key)),
    })));
    return stickers.filter(Boolean);
  } catch {
    return [];
  }
}

async function getMoodStickers(mood) {
  try {
    const keys = await redis.keys(`sticker:mood:${mood}:*`);
    const stickers = await Promise.all(keys.map(async (key) => ({
      id: key.replace(`sticker:mood:${mood}:`, ""),
      mood,
      ...(await redis.get(key)),
    })));
    return stickers.filter(Boolean);
  } catch {
    return [];
  }
}

async function getRandomSticker(mood) {
  try {
    const preferred = await getMoodStickers(mood);
    const stickers = preferred.length ? preferred : await getMoodStickers("neutral");
    return stickers.length ? stickers[Math.floor(Math.random() * stickers.length)] : null;
  } catch {
    return null;
  }
}

async function classifySticker(id, mood) {
  const data = await redis.get(`sticker:standby:${id}`);
  if (!data) return false;
  await Promise.all([
    redis.set(`sticker:mood:${mood}:${id}`, data),
    redis.del(`sticker:standby:${id}`),
  ]);
  return true;
}

async function clearStickerKeys(pattern) {
  const keys = await redis.keys(pattern);
  await Promise.all(keys.map((key) => redis.del(key)));
  return keys.length;
}

async function clearAllStickers() {
  const [standby, moods] = await Promise.all([
    redis.keys("sticker:standby:*"),
    redis.keys("sticker:mood:*"),
  ]);
  const keys = [...standby, ...moods];
  await Promise.all(keys.map((key) => redis.del(key)));
  return keys.length;
}

async function deleteSticker(type, mood, id) {
  if (type === "standby") await redis.del(`sticker:standby:${id}`);
  if (type === "mood") await redis.del(`sticker:mood:${mood}:${id}`);
}

module.exports = {
  loadMemory,
  saveMemory,
  loadMood,
  saveMood,
  isStickerEnabled,
  setStickerEnabled,
  saveName,
  saveGroupMember,
  isBlacklisted,
  toggleBlacklist,
  getAllChatIds,
  loadStats,
  saveStats,
  purgeAllMemory,
  purgeChatMemory,
  listChats,
  saveStandbySticker,
  getStandbyStickers,
  getMoodStickers,
  getRandomSticker,
  classifySticker,
  clearStickerKeys,
  clearAllStickers,
  deleteSticker,
};
