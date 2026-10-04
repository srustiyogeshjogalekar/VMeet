const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");
const { attachVideoSocket, hashHostToken, initializeMeetingStore } = require("./socket/videoSocket");
const { createAuthRouter } = require("./auth");
const { openDatabase } = require("./database");

const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((origin) => origin.trim());
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 2_000_000,
});
const meetings = new Map();
function resolveAuthSecret() {
  if (process.env.JWT_SECRET) {
    if (process.env.NODE_ENV === "production" && Buffer.byteLength(process.env.JWT_SECRET) < 32) {
      throw new Error("JWT_SECRET must contain at least 32 random bytes in production.");
    }
    return process.env.JWT_SECRET;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("Set JWT_SECRET to at least 32 random bytes in production.");
  }

  const secretPath = path.join(__dirname, "..", "data", "session.secret");
  try {
    return fs.readFileSync(secretPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const secret = crypto.randomBytes(32).toString("base64url");
    try {
      fs.writeFileSync(secretPath, secret, { flag: "wx", mode: 0o600 });
      return secret;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      return fs.readFileSync(secretPath, "utf8");
    }
  }
}

async function startServer() {
  const authDatabase = await openDatabase(path.join(__dirname, "..", "data", "accounts.sqlite"));
  const authSecret = resolveAuthSecret();
  for (const [id, room] of initializeMeetingStore(authDatabase)) meetings.set(id, room);
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/api/auth", createAuthRouter({ database: authDatabase, secret: authSecret }));

  app.post("/api/meetings", (_req, res) => {
    const id = crypto.randomBytes(6).toString("base64url");
    const hostToken = crypto.randomBytes(32).toString("base64url");
    const room = {
      id,
      hostTokenHash: hashHostToken(hostToken),
      participants: new Map(),
      locked: false,
      permissions: { screenShare: true, chat: true },
      createdAt: Date.now(),
      expiresAt: null,
      expirationTimer: null,
    };
    try {
      authDatabase.prepare(`
        INSERT INTO meetings (id, host_token_hash, locked, allow_screen_share, allow_chat, created_at, expires_at)
        VALUES (?, ?, 0, 1, 1, ?, NULL)
      `).run(id, room.hostTokenHash, room.createdAt);
      meetings.set(id, room);
    } catch (error) {
      console.error("Could not save new meeting.", error);
      res.status(500).json({ error: "Could not create a meeting. Please try again." });
      return;
    }
    res.status(201).json({ id, hostToken, maxParticipants: 8 });
  });

  attachVideoSocket(io, meetings, authDatabase);
  server.listen(port, () => {
    console.log(`VMeet signaling server listening on port ${port}`);
  });
}

const port = Number(process.env.PORT) || 3001;
startServer().catch((error) => {
  console.error("Could not start the VMeet server.", error);
  process.exitCode = 1;
});