const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const express = require("express");
const { rateLimit } = require("express-rate-limit");

const SESSION_COOKIE = "vmeet_session";
const SESSION_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.created_at,
  };
}

function createAuthRouter({ database, secret }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const router = express.Router();
  const attempts = rateLimit({
    windowMs: 15 * 60 * 1_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many authentication attempts. Try again in 15 minutes." },
  });
  const secureCookie = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_AGE_MS,
  };
  const clearCookieOptions = {
    httpOnly: cookieOptions.httpOnly,
    secure: cookieOptions.secure,
    sameSite: cookieOptions.sameSite,
    path: cookieOptions.path,
  };

  function createSession(user, response) {
    const token = jwt.sign({ sub: user.id }, secret, { expiresIn: "7d" });
    response.cookie(SESSION_COOKIE, token, cookieOptions);
    return publicUser(user);
  }

  router.post("/register", attempts, async (request, response) => {
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";

    if (name.length < 2 || name.length > 60) {
      response.status(400).json({ error: "Name must be between 2 and 60 characters." });
      return;
    }
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
      response.status(400).json({ error: "Enter a valid email address." });
      return;
    }
    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      response.status(400).json({ error: "Password must be at least 8 characters and no more than 72 bytes." });
      return;
    }

    try {
      const id = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(password, 12);
      database.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)")
        .run(id, name, email, passwordHash);
      const user = database.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(id);
      response.status(201).json({ user: createSession(user, response) });
    } catch (error) {
      if (/UNIQUE constraint failed: users\.email/i.test(error.message)) {
        response.status(409).json({ error: "An account with this email already exists." });
        return;
      }
      console.error("Account registration failed.", error);
      response.status(500).json({ error: "Could not create your account. Please try again." });
    }
  });

  router.post("/login", attempts, async (request, response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || !password || Buffer.byteLength(password, "utf8") > 72) {
      response.status(400).json({ error: "Enter your email and password." });
      return;
    }

    try {
      const user = database.prepare("SELECT id, name, email, password_hash, created_at FROM users WHERE email = ?").get(email);
      const matches = user ? await bcrypt.compare(password, user.password_hash) : false;
      if (!matches) {
        response.status(401).json({ error: "Email or password is incorrect." });
        return;
      }
      response.json({ user: createSession(user, response) });
    } catch (error) {
      console.error("Account login failed.", error);
      response.status(500).json({ error: "Could not sign in. Please try again." });
    }
  });

  router.get("/me", (request, response) => {
    const token = request.cookies?.[SESSION_COOKIE];
    if (!token) {
      response.status(401).json({ error: "Not signed in." });
      return;
    }
    try {
      const payload = jwt.verify(token, secret);
      const user = database.prepare("SELECT id, name, email, created_at FROM users WHERE id = ?").get(payload.sub);
      if (!user) {
        response.clearCookie(SESSION_COOKIE, clearCookieOptions);
        response.status(401).json({ error: "Not signed in." });
        return;
      }
      response.json({ user: publicUser(user) });
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
        response.clearCookie(SESSION_COOKIE, clearCookieOptions);
        response.status(401).json({ error: "Session expired. Please sign in again." });
        return;
      }
      console.error("Could not verify account session.", error);
      response.status(500).json({ error: "Could not verify your session." });
    }
  });

  router.post("/logout", (_request, response) => {
    response.clearCookie(SESSION_COOKIE, clearCookieOptions);
    response.json({ success: true });
  });

  return router;
}

module.exports = { createAuthRouter };
