const crypto = require("node:crypto");

const MAX_PARTICIPANTS = 8;
const MAX_CHAT_LENGTH = 5_000;
const MAX_FILE_SIZE = 1_400_000;
const CHAT_HISTORY_LIMIT = 100;
const CHAT_HISTORY_BYTES_LIMIT = 1_500_000;
const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MEETING_RECONNECT_GRACE_MS = 60 * 60 * 1_000;

function hashHostToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function initializeMeetingStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      host_token_hash TEXT NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      allow_screen_share INTEGER NOT NULL DEFAULT 1,
      allow_chat INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS meeting_chat (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      text TEXT NOT NULL,
      file_name TEXT,
      file_data TEXT,
      sent_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meeting_chat_room_sent
      ON meeting_chat (room_id, sent_at, id);
  `);

  const now = Date.now();
  const reconnectDeadline = now + MEETING_RECONNECT_GRACE_MS;
  database.prepare("UPDATE meetings SET expires_at = ? WHERE expires_at IS NULL").run(reconnectDeadline);
  database.prepare("DELETE FROM meetings WHERE expires_at <= ?").run(now);
  database.prepare("DELETE FROM meeting_chat WHERE sent_at < ?").run(now - CHAT_RETENTION_MS);

  return new Map(database.prepare(`
    SELECT id, host_token_hash AS hostTokenHash, locked, allow_screen_share AS allowScreenShare,
      allow_chat AS allowChat, created_at AS createdAt, expires_at AS expiresAt
    FROM meetings
  `).all().map((row) => [row.id, {
    id: row.id,
    hostTokenHash: row.hostTokenHash,
    participants: new Map(),
    locked: Boolean(row.locked),
    permissions: {
      screenShare: Boolean(row.allowScreenShare),
      chat: Boolean(row.allowChat),
    },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    expirationTimer: null,
  }]));
}

function isValidName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 60;
}

function tokensMatch(expected, received) {
  if (typeof expected !== "string" || typeof received !== "string") return false;
  const expectedHash = /^[a-f0-9]{64}$/i.test(expected)
    ? Buffer.from(expected, "hex")
    : crypto.createHash("sha256").update(expected).digest();
  const receivedHash = crypto.createHash("sha256").update(received).digest();
  return crypto.timingSafeEqual(expectedHash, receivedHash);
}

function publicParticipant(participant) {
  return {
    id: participant.id,
    name: participant.name,
    host: participant.host,
    cohost: participant.cohost,
    audio: participant.audio,
    video: participant.video,
    handRaised: participant.handRaised,
    speaking: participant.speaking,
    quality: participant.quality,
  };
}

function emitParticipants(io, room) {
  io.to(room.id).emit(
    "room:participants",
    Array.from(room.participants.values(), publicParticipant),
  );
}

function attachVideoSocket(io, meetings, database) {
  let scheduleExpiration;
  let persistRoom;
  if (database) {
    scheduleExpiration = (room) => {
      if (room.expirationTimer) clearTimeout(room.expirationTimer);
      if (room.expiresAt === null) room.expiresAt = Date.now() + MEETING_RECONNECT_GRACE_MS;
      const delay = Math.max(0, room.expiresAt - Date.now());
      room.expirationTimer = setTimeout(() => {
        if (meetings.get(room.id) !== room || room.participants.size > 0) return;
        database.prepare("DELETE FROM meetings WHERE id = ?").run(room.id);
        meetings.delete(room.id);
      }, delay);
      room.expirationTimer.unref?.();
    };

    for (const room of meetings.values()) {
      if (room.participants.size === 0) scheduleExpiration(room);
    }
    persistRoom = (room) => {
      database.prepare(`
        UPDATE meetings
        SET locked = ?, allow_screen_share = ?, allow_chat = ?, expires_at = ?
        WHERE id = ?
      `).run(
        room.locked ? 1 : 0,
        room.permissions.screenShare ? 1 : 0,
        room.permissions.chat ? 1 : 0,
        room.expiresAt,
        room.id,
      );
    };
  }

  io.on("connection", (socket) => {
    socket.on("room:join", (payload, acknowledge = () => {}) => {
      if (typeof acknowledge !== "function") return;
      if (socket.data.roomId) {
        acknowledge({ error: "This connection has already joined a meeting." });
        return;
      }
      const roomId = typeof payload?.roomId === "string" ? payload.roomId : "";
      const room = meetings.get(roomId);
      const name = isValidName(payload?.name) ? payload.name.trim() : "";
      if (!room || !name) {
        acknowledge({ error: "This meeting could not be found, or the name is invalid." });
        return;
      }

      const isHost = tokensMatch(room.hostTokenHash || room.hostToken, payload?.hostToken);
      if (room.locked && !isHost) {
        acknowledge({ error: "This meeting is locked by the host." });
        return;
      }
      if (room.participants.size >= MAX_PARTICIPANTS) {
        acknowledge({ error: `This peer-to-peer meeting is limited to ${MAX_PARTICIPANTS} participants.` });
        return;
      }

      let chatHistory = [];
      try {
        if (database) {
          const savedMessages = database.prepare(`
            SELECT id, sender_id AS senderId, sender_name AS senderName, text,
              file_name AS fileName, file_data AS fileData, sent_at AS sentAt
            FROM meeting_chat
            WHERE room_id = ? AND sent_at >= ?
            ORDER BY sent_at DESC, rowid DESC
            LIMIT ?
          `).all(room.id, Date.now() - CHAT_RETENTION_MS, CHAT_HISTORY_LIMIT);
          let historyBytes = 0;
          for (const message of savedMessages) {
            const chatMessage = {
              id: message.id,
              senderId: message.senderId,
              senderName: message.senderName,
              text: message.text,
              file: message.fileData ? { name: message.fileName, data: message.fileData } : null,
              sentAt: message.sentAt,
            };
            const messageBytes = Buffer.byteLength(JSON.stringify(chatMessage));
            if (historyBytes + messageBytes > CHAT_HISTORY_BYTES_LIMIT) break;
            chatHistory.push(chatMessage);
            historyBytes += messageBytes;
          }
          chatHistory.reverse();
        }
      } catch (error) {
        console.error("Could not load meeting chat history.", error);
        acknowledge({ error: "Could not load this meeting's chat history. Please try again." });
        return;
      }

      if (room.expiresAt) {
        if (room.expirationTimer) clearTimeout(room.expirationTimer);
        room.expirationTimer = null;
        room.expiresAt = null;
        if (database) persistRoom(room);
      }

      const participant = {
        id: socket.id,
        name,
        host: isHost,
        cohost: false,
        audio: false,
        video: false,
        handRaised: false,
        speaking: false,
        quality: "good",
      };
      room.participants.set(socket.id, participant);
      socket.data.roomId = room.id;
      socket.join(room.id);

      acknowledge({
        selfId: socket.id,
        host: isHost,
        participants: Array.from(room.participants.values(), publicParticipant),
        permissions: room.permissions,
        locked: room.locked,
        maxParticipants: MAX_PARTICIPANTS,
        chatHistory,
      });
      socket.to(room.id).emit("participant:joined", publicParticipant(participant));
    });

    socket.on("signal", (payload = {}) => {
      if (!payload || typeof payload !== "object") return;
      const { to, description, candidate } = payload;
      const roomId = socket.data.roomId;
      const room = roomId && meetings.get(roomId);
      if (!room || !room.participants.has(socket.id) || typeof to !== "string" || !room.participants.has(to)) return;
      if (description && typeof description === "object") {
        io.to(to).emit("signal", { from: socket.id, description });
      } else if (candidate && typeof candidate === "object") {
        io.to(to).emit("signal", { from: socket.id, candidate });
      }
    });

    socket.on("participant:update", (updates = {}) => {
      if (!updates || typeof updates !== "object") return;
      const room = meetings.get(socket.data.roomId);
      const participant = room?.participants.get(socket.id);
      if (!participant) return;
      for (const key of ["audio", "video", "speaking", "handRaised"]) {
        if (typeof updates[key] === "boolean") participant[key] = updates[key];
      }
      if (["good", "fair", "poor"].includes(updates.quality)) participant.quality = updates.quality;
      emitParticipants(io, room);
    });

    socket.on("room:chat", (message = {}) => {
      if (!message || typeof message !== "object") return;
      const room = meetings.get(socket.data.roomId);
      const participant = room?.participants.get(socket.id);
      if (!room || !participant || (!room.permissions.chat && !participant.host && !participant.cohost)) return;
      const text = typeof message.text === "string" ? message.text.trim() : "";
      const file = message.file;
      if (text.length > MAX_CHAT_LENGTH) return;
      if (
        file &&
        (typeof file.name !== "string" ||
          file.name.length > 180 ||
          typeof file.data !== "string" ||
          file.data.length > MAX_FILE_SIZE ||
          !/^data:[\w.+/-]+;base64,/.test(file.data))
      ) return;
      if (!text && !file) return;
      const outgoing = {
        id: crypto.randomUUID(),
        senderId: participant.id,
        senderName: participant.name,
        text,
        file: file ? { name: file.name, data: file.data } : null,
        sentAt: Date.now(),
      };
      if (database) {
        try {
          database.prepare(`
            INSERT INTO meeting_chat
              (id, room_id, sender_id, sender_name, text, file_name, file_data, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            outgoing.id,
            room.id,
            outgoing.senderId,
            outgoing.senderName,
            outgoing.text,
            outgoing.file?.name || null,
            outgoing.file?.data || null,
            outgoing.sentAt,
          );
          database.prepare(`
            DELETE FROM meeting_chat
            WHERE room_id = ?
              AND id NOT IN (
                SELECT id FROM meeting_chat
                WHERE room_id = ?
                ORDER BY sent_at DESC, rowid DESC
                LIMIT ?
              )
          `).run(room.id, room.id, CHAT_HISTORY_LIMIT);
        } catch (error) {
          console.error("Could not save meeting chat message.", error);
          socket.emit("room:chat:error", { error: "Your message could not be saved. Please try again." });
          return;
        }
      }
      io.to(room.id).emit("room:chat", outgoing);
    });

    socket.on("moderation:mute", (payload = {}) => {
      if (!payload || typeof payload !== "object") return;
      const { participantId } = payload;
      const room = meetings.get(socket.data.roomId);
      const moderator = room?.participants.get(socket.id);
      const target = room?.participants.get(participantId);
      if (!room || !moderator || !(moderator.host || moderator.cohost) || !target || target.host) return;
      io.to(target.id).emit("moderation:mute");
    });

    socket.on("moderation:remove", (payload = {}) => {
      if (!payload || typeof payload !== "object") return;
      const { participantId } = payload;
      const room = meetings.get(socket.data.roomId);
      const moderator = room?.participants.get(socket.id);
      const target = room?.participants.get(participantId);
      if (!room || !moderator || !(moderator.host || moderator.cohost) || !target || target.host) return;
      io.to(target.id).emit("moderation:removed");
      io.in(target.id).disconnectSockets(true);
    });

    socket.on("moderation:lock", (payload = {}) => {
      if (!payload || typeof payload !== "object") return;
      const { locked } = payload;
      const room = meetings.get(socket.data.roomId);
      const moderator = room?.participants.get(socket.id);
      if (!room || !moderator || !(moderator.host || moderator.cohost) || typeof locked !== "boolean") return;
      room.locked = locked;
      if (database) persistRoom(room);
      io.to(room.id).emit("room:locked", room.locked);
    });

    socket.on("moderation:cohost", (payload = {}) => {
      if (!payload || typeof payload !== "object") return;
      const { participantId, cohost } = payload;
      const room = meetings.get(socket.data.roomId);
      const moderator = room?.participants.get(socket.id);
      const target = room?.participants.get(participantId);
      if (!room || !moderator?.host || !target || target.host || typeof cohost !== "boolean") return;
      target.cohost = cohost;
      io.to(room.id).emit("participant:role", { participantId, cohost });
    });

    socket.on("moderation:permissions", (payload = {}) => {
      if (!payload || typeof payload !== "object") return;
      const { screenShare, chat } = payload;
      const room = meetings.get(socket.data.roomId);
      const moderator = room?.participants.get(socket.id);
      if (!room || !moderator || !(moderator.host || moderator.cohost)) return;
      if (typeof screenShare === "boolean") room.permissions.screenShare = screenShare;
      if (typeof chat === "boolean") room.permissions.chat = chat;
      if (database) persistRoom(room);
      io.to(room.id).emit("room:permissions", room.permissions);
    });

    socket.on("moderation:end", (acknowledge = () => {}) => {
      if (typeof acknowledge !== "function") return;
      const room = meetings.get(socket.data.roomId);
      const moderator = room?.participants.get(socket.id);
      if (!room || !moderator?.host) {
        acknowledge({ error: "Only the host can end this meeting." });
        return;
      }
      acknowledge({ success: true });
      io.to(room.id).emit("room:ended");
      io.in(room.id).disconnectSockets(true);
      if (room.expirationTimer) clearTimeout(room.expirationTimer);
      if (database) database.prepare("DELETE FROM meetings WHERE id = ?").run(room.id);
      meetings.delete(room.id);
    });

    socket.on("disconnect", () => {
      const roomId = socket.data.roomId;
      const room = roomId && meetings.get(roomId);
      if (!room || !room.participants.has(socket.id)) return;
      room.participants.delete(socket.id);
      socket.to(room.id).emit("participant:left", socket.id);
      emitParticipants(io, room);
      if (room.participants.size === 0) {
        if (database) scheduleExpiration(room);
        else {
          room.expirationTimer = setTimeout(() => meetings.delete(room.id), MEETING_RECONNECT_GRACE_MS);
          room.expirationTimer.unref?.();
        }
      }
    });
  });
}

module.exports = {
  attachVideoSocket,
  initializeMeetingStore,
  hashHostToken,
  MAX_PARTICIPANTS,
  CHAT_HISTORY_LIMIT,
  CHAT_RETENTION_MS,
  MEETING_RECONNECT_GRACE_MS,
};