"use strict";

const { MAX_ATTEMPTS, LOCKOUT_DURATION, getRateLimit } = require("../state");

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

function login(req, res) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || "unknown";
  const entry = getRateLimit(ip);
  const now = Date.now();

  if (entry.lockedUntil && now < entry.lockedUntil) {
    const minutesLeft = Math.ceil((entry.lockedUntil - now) / 60000);
    return res.status(429).json({ error: "locked", minutesLeft });
  }

  const { username, password } = req.body;
  if (username === process.env.DASHBOARD_USER && password === process.env.DASHBOARD_PASS) {
    entry.count = 0;
    entry.lockedUntil = null;
    return res.json({ token: process.env.DASHBOARD_TOKEN });
  }

  entry.count++;
  const attemptsLeft = MAX_ATTEMPTS - entry.count;
  if (attemptsLeft <= 0) {
    entry.lockedUntil = now + LOCKOUT_DURATION;
    return res.status(429).json({ error: "locked", minutesLeft: 10 });
  }

  return res.status(401).json({ error: "invalid", attemptsLeft });
}

module.exports = { authMiddleware, login };
