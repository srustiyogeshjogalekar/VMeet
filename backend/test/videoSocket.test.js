const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { Server } = require("socket.io");
const { io: createClient } = require("socket.io-client");
const { openDatabase } = require("../src/database");
const {
  attachVideoSocket,
  hashHostToken,
  initializeMeetingStore,
  MAX_PARTICIPANTS,
} = require("../src/socket/videoSocket");

const roomId = "test-room";
const hostToken = "test-host-token";
const rooms = new Map([
  [roomId, {
    id: roomId,
    hostToken,
    participants: new Map(),
    locked: false,
    permissions: { screenShare: true, chat: true },
    expiresAt: null,
  }],
]);
const sockets = new Set();
let httpServer;
let socketServer;
let address;
let database;
let databasePath;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vmeet-chat-test-"));
  databasePath = path.join(temporaryDirectory, "chat.sqlite");
  database = await openDatabase(databasePath);
  initializeMeetingStore(database);
  httpServer = http.createServer();
  socketServer = new Server(httpServer);
  attachVideoSocket(socketServer, rooms, database);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  address = `http://127.0.0.1:${httpServer.address().port}`;
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  await new Promise((resolve) => socketServer.close(resolve));
  database.close();
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function connect() {
  const socket = createClient(address, { autoConnect: false, reconnection: false });
  sockets.add(socket);
  socket.connect();
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

function join(socket, payload) {
  return new Promise((resolve) => socket.emit("room:join", payload, resolve));
}

function receive(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

test("authenticates meeting roles, isolates rooms, enforces moderation, and caps mesh participants", async () => {
  const host = await connect();
  const hostJoin = await join(host, { roomId, name: "Host", hostToken });
  assert.equal(hostJoin.host, true);

  const guest = await connect();
  const guestJoin = await join(guest, { roomId, name: "Guest", hostToken: "invalid-token" });
  assert.equal(guestJoin.host, false);
  assert.equal(guestJoin.participants.find((participant) => participant.id === guest.id).name, "Guest");

  const guestTwo = await connect();
  await join(guestTwo, { roomId, name: "Guest two" });
  guest.emit("moderation:lock", { locked: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rooms.get(roomId).locked, false);

  const lockedEvent = receive(guest, "room:locked");
  host.emit("moderation:lock", { locked: true });
  assert.equal(await lockedEvent, true);
  const blocked = await connect();
  assert.match((await join(blocked, { roomId, name: "Blocked" })).error, /locked/);

  host.emit("moderation:permissions", { chat: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  let blockedGuestMessageReceived = false;
  host.once("room:chat", (message) => {
    blockedGuestMessageReceived = message.text === "should not be delivered";
  });
  guest.emit("room:chat", { text: "should not be delivered" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(blockedGuestMessageReceived, false);
  const hostChat = receive(guest, "room:chat");
  host.emit("room:chat", { text: "host can still moderate" });
  assert.equal((await hostChat).text, "host can still moderate");

  const otherRoomJoin = await join(await connect(), { roomId: "missing-room", name: "Stranger" });
  assert.match(otherRoomJoin.error, /could not be found/);

  host.emit("moderation:lock", { locked: false });
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let index = 0; index < MAX_PARTICIPANTS - 3; index += 1) {
    const socket = await connect();
    assert.equal((await join(socket, { roomId, name: `Guest ${index + 3}` })).error, undefined);
  }
  const overflow = await connect();
  assert.match((await join(overflow, { roomId, name: "Overflow" })).error, /limited to/);
  assert.equal(rooms.get(roomId).participants.size, MAX_PARTICIPANTS);
});

test("persists chat and attachments for room rejoin and limits stored history", async () => {
  const historyRoomId = "chat-history-room";
  rooms.set(historyRoomId, {
    id: historyRoomId,
    hostToken: "history-host-token",
    participants: new Map(),
    locked: false,
    permissions: { screenShare: true, chat: true },
    expiresAt: null,
  });

  const host = await connect();
  await join(host, { roomId: historyRoomId, name: "History host", hostToken: "history-host-token" });
  const sent = receive(host, "room:chat");
  host.emit("room:chat", {
    text: "Saved across refresh",
    file: { name: "notes.txt", data: "data:text/plain;base64,SGVsbG8=" },
  });
  await sent;

  const reopenedDatabase = await openDatabase(databasePath);
  const persistedRows = reopenedDatabase.prepare(
    "SELECT id FROM meeting_chat WHERE room_id = ?",
  ).all(historyRoomId);
  assert.equal(persistedRows.length, 1);
  reopenedDatabase.close();

  const returningGuest = await connect();
  const response = await join(returningGuest, { roomId: historyRoomId, name: "Returning guest" });
  assert.equal(response.chatHistory.length, 1);
  assert.equal(response.chatHistory[0].text, "Saved across refresh");
  assert.deepEqual(response.chatHistory[0].file, {
    name: "notes.txt",
    data: "data:text/plain;base64,SGVsbG8=",
  });
});

test("restores persisted meetings and permissions after server restart", async () => {
  const restoredRoomId = "restored-room";
  const restoredHostToken = "restored-host-token";
  database.prepare(`
    INSERT INTO meetings
      (id, host_token_hash, locked, allow_screen_share, allow_chat, created_at, expires_at)
    VALUES (?, ?, 1, 0, 0, ?, NULL)
  `).run(restoredRoomId, hashHostToken(restoredHostToken), Date.now());

  const restoredMeetings = initializeMeetingStore(database);
  const restoredRoom = restoredMeetings.get(restoredRoomId);
  assert.ok(restoredRoom);
  assert.equal(restoredRoom.locked, true);
  assert.deepEqual(restoredRoom.permissions, { screenShare: false, chat: false });
  assert.ok(restoredRoom.expiresAt > Date.now());
  rooms.set(restoredRoomId, restoredRoom);

  const guest = await connect();
  assert.match((await join(guest, { roomId: restoredRoomId, name: "Guest" })).error, /locked/);
  const host = await connect();
  const response = await join(host, {
    roomId: restoredRoomId,
    name: "Restored host",
    hostToken: restoredHostToken,
  });
  assert.equal(response.host, true);
  assert.equal(response.locked, true);
  assert.deepEqual(response.permissions, { screenShare: false, chat: false });
});
