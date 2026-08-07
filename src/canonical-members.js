"use strict";

const { redis } = require("./config");
const { listChats } = require("./storage");
const {
  loadRelationship,
  publicRelationship,
} = require("./relationship/service");

function normalizeAlias(value) {
  if (typeof value !== "string" || !value.includes("@")) return null;
  const [rawLocal, rawServer] = value.trim().split("@");
  if (!rawLocal || !rawServer) return null;
  const local = rawLocal.replace(/:\d+$/, "");
  const server = rawServer === "c.us" ? "s.whatsapp.net" : rawServer;
  const jid = `${local}@${server}`;
  return /@(?:s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function isPersonId(value) {
  return typeof value === "string" && /^person_[0-9a-f-]+$/i.test(value);
}

async function directBlacklisted(key) {
  if (!key) return false;
  try {
    const value = await redis.get(`blacklist:${key}`);
    return value === true || value === "true";
  } catch {
    return false;
  }
}

async function resolveIdentity(identifier, hint = null) {
  let personId = isPersonId(hint?.id) ? hint.id : null;
  const normalized = normalizeAlias(identifier);
  const hintedAliases = unique([
    ...(Array.isArray(hint?.aliases) ? hint.aliases.map(normalizeAlias) : []),
    normalized,
  ]);

  if (!personId && isPersonId(identifier)) personId = identifier;
  if (!personId && normalized) {
    try {
      const stored = await redis.get(`identity:alias:${normalized}`);
      if (isPersonId(stored)) personId = stored;
    } catch {}
  }

  let person = hint && personId === hint.id ? hint : null;
  if (!person && personId) {
    try {
      const stored = await redis.get(`identity:person:${personId}`);
      if (stored && typeof stored === "object") person = stored;
    } catch {}
  }

  const aliases = unique([
    ...hintedAliases,
    ...(Array.isArray(person?.aliases) ? person.aliases.map(normalizeAlias) : []),
  ]);

  return {
    id: personId,
    aliases,
    person,
    canonicalId: personId || normalized || identifier,
  };
}

async function canonicalizeStoredMember(rawId) {
  const identity = await resolveIdentity(rawId);
  return {
    rawId,
    ...identity,
    canonicalId: identity.canonicalId || rawId,
  };
}

async function saveCanonicalGroupMember(groupId, fallbackId, name, personHint = null) {
  const identity = await resolveIdentity(fallbackId, personHint);
  const memberId = identity.canonicalId;
  if (!memberId) return null;

  try {
    const existing = await redis.get(`members:${groupId}`);
    const rawMembers = Array.isArray(existing) ? existing : [];
    const migrated = [];

    for (const rawId of rawMembers) {
      const stored = await canonicalizeStoredMember(rawId);
      if (stored.canonicalId === memberId) continue;
      if (!migrated.includes(stored.canonicalId)) migrated.push(stored.canonicalId);
    }

    migrated.push(memberId);
    await redis.set(`members:${groupId}`, migrated);

    const displayName = name || identity.person?.displayName || null;
    if (displayName) await redis.set(`name:${groupId}:${memberId}`, displayName);
  } catch (error) {
    console.error("[members] Failed to save canonical group member:", error.message);
  }

  return memberId;
}

async function saveCanonicalMemberMood(groupId, memberId, mood) {
  const identity = await resolveIdentity(memberId);
  const canonicalId = identity.canonicalId;
  if (!canonicalId) return;
  await redis.set(`mood:${groupId}:${canonicalId}`, mood);
}

async function loadCanonicalMemberMood(groupId, canonicalId, aliases, legacyMembers = []) {
  const canonicalKey = `mood:${groupId}:${canonicalId}`;
  let canonicalMood = null;

  try {
    canonicalMood = await redis.get(canonicalKey);
  } catch {}

  if (canonicalMood) return canonicalMood;

  const candidateIds = unique([
    ...legacyMembers.map((member) => member.id),
    ...aliases,
  ]);
  const legacyMoods = [];

  for (const id of candidateIds) {
    try {
      const mood = await redis.get(`mood:${groupId}:${id}`);
      if (mood) legacyMoods.push(mood);
    } catch {}
  }

  const mood = legacyMoods.find((value) => value !== "neutral") ||
    legacyMoods[0] ||
    "neutral";

  if (mood !== "neutral" || legacyMoods.length) {
    await redis.set(canonicalKey, mood).catch(() => {});
  }

  return mood;
}

async function relationshipForPerson(personId) {
  if (!isPersonId(personId)) return null;
  return publicRelationship(await loadRelationship(personId));
}

async function isCanonicalBlacklisted(identifier) {
  if (await directBlacklisted(identifier)) return true;

  const identity = await resolveIdentity(identifier);
  const keys = unique([identity.id, ...identity.aliases]);

  for (const key of keys) {
    if (await directBlacklisted(key)) {
      if (identity.id && key !== identity.id) {
        await redis.set(`blacklist:${identity.id}`, true).catch(() => {});
      }
      return true;
    }
  }

  return false;
}

async function toggleCanonicalBlacklist(identifier) {
  const identity = await resolveIdentity(identifier);
  const target = identity.id || identifier;
  const keys = unique([identifier, target, ...identity.aliases]);
  const current = await isCanonicalBlacklisted(identifier);

  if (current) {
    await Promise.all(keys.map((key) => redis.del(`blacklist:${key}`).catch(() => {})));
    return false;
  }

  await redis.set(`blacklist:${target}`, true);
  await Promise.all(
    keys.filter((key) => key !== target)
      .map((key) => redis.del(`blacklist:${key}`).catch(() => {}))
  );
  return true;
}

function splitMemberMoodScope(scope) {
  const marker = "@g.us:";
  const index = typeof scope === "string" ? scope.indexOf(marker) : -1;
  if (index < 0) return null;

  return {
    groupId: scope.slice(0, index + "@g.us".length),
    memberId: scope.slice(index + marker.length),
  };
}

async function resetCanonicalMood(scope) {
  const memberScope = splitMemberMoodScope(scope);
  if (!memberScope) {
    await redis.set(`mood:${scope}`, "neutral");
    return;
  }

  const identity = await resolveIdentity(memberScope.memberId);
  const canonicalId = identity.canonicalId || memberScope.memberId;
  const keys = unique([
    `${memberScope.groupId}:${canonicalId}`,
    ...identity.aliases.map((alias) => `${memberScope.groupId}:${alias}`),
  ]);

  await Promise.all(keys.map((key) => redis.set(`mood:${key}`, "neutral")));
}

function bestLoadedMood(members) {
  const moods = (members || []).map((member) => member?.mood).filter(Boolean);
  return moods.find((mood) => mood !== "neutral") || moods[0] || "neutral";
}

async function canonicalizeGroupForDashboard(chat) {
  if (!Array.isArray(chat.members) || !chat.members.length) return chat;

  // listChats() has already loaded mood and blacklist state for every member.
  // Resolve identities concurrently, then reuse those loaded values instead of
  // repeating the same Redis reads during canonical dashboard shaping.
  const resolvedMembers = await Promise.all(chat.members.map(async (member) => ({
    member,
    identity: await resolveIdentity(member.id),
  })));

  const buckets = new Map();
  for (const { member, identity } of resolvedMembers) {
    const canonicalId = identity.canonicalId || member.id;
    let bucket = buckets.get(canonicalId);

    if (!bucket) {
      bucket = {
        canonicalId,
        aliases: new Set(identity.aliases),
        identity,
        legacyMembers: [],
      };
      buckets.set(canonicalId, bucket);
    } else {
      for (const alias of identity.aliases) bucket.aliases.add(alias);
      if (!bucket.identity.person && identity.person) bucket.identity = identity;
    }

    bucket.legacyMembers.push(member);
  }

  const canonicalMembers = await Promise.all([...buckets.values()].map(async (bucket) => {
    const aliases = [...bucket.aliases];
    const canonicalNameKey = `name:${chat.id}:${bucket.canonicalId}`;
    const personId = bucket.identity.id || (isPersonId(bucket.canonicalId) ? bucket.canonicalId : null);

    const [canonicalName, relationship] = await Promise.all([
      redis.get(canonicalNameKey).catch(() => null),
      relationshipForPerson(personId),
    ]);

    const legacyName = bucket.legacyMembers
      .map((member) => member.name)
      .find((value) => value && !/^\+?\d+$/.test(String(value)));

    const name = canonicalName ||
      bucket.identity.person?.displayName ||
      legacyName ||
      bucket.canonicalId.split("@")[0];

    // Mood and blacklist were already resolved by listChats(). When legacy PN/LID
    // rows collapse into one canonical person, preserve the strongest loaded state.
    const mood = bestLoadedMood(bucket.legacyMembers);
    const blacklisted = bucket.legacyMembers.some((member) => Boolean(member.blacklisted));

    if (!canonicalName && name) {
      await redis.set(canonicalNameKey, name).catch(() => {});
    }

    return {
      id: bucket.canonicalId,
      canonicalPersonId: personId,
      aliases,
      name,
      mood,
      relationship,
      blacklisted,
    };
  }));

  chat.members = canonicalMembers;

  // Keep the lazy legacy-ID migration, but avoid rewriting an already canonical
  // member list every time the dashboard opens.
  const previousIds = resolvedMembers.map(({ member }) => member.id);
  const canonicalIds = canonicalMembers.map((member) => member.id);
  const membershipChanged = previousIds.length !== canonicalIds.length ||
    previousIds.some((id, index) => id !== canonicalIds[index]);

  if (membershipChanged) {
    await redis.set(`members:${chat.id}`, canonicalIds).catch(() => {});
  }

  return chat;
}

async function canonicalizeDirectChatForDashboard(chat) {
  const identity = await resolveIdentity(chat.id);
  chat.canonicalPersonId = identity.id || null;
  chat.relationship = await relationshipForPerson(identity.id);
  return chat;
}

async function listCanonicalChats() {
  const chats = await listChats();

  // Process independent chats concurrently. This keeps the response shape and
  // canonicalization behavior identical while removing the serial Redis waterfall.
  return Promise.all(chats.map((chat) => chat.isGroup
    ? canonicalizeGroupForDashboard(chat)
    : canonicalizeDirectChatForDashboard(chat)));
}

module.exports = {
  resolveIdentity,
  saveCanonicalGroupMember,
  saveCanonicalMemberMood,
  isCanonicalBlacklisted,
  toggleCanonicalBlacklist,
  resetCanonicalMood,
  listCanonicalChats,
};
