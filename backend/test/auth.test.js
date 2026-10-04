const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");
const { after, before, test } = require("node:test");
const { createAuthRouter } = require("../src/auth");
const { openDatabase } = require("../src/database");

let temporaryDirectory;
let httpServer;
let baseUrl;

before(async () => {
  temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "vmeet-auth-test-"));
  const database = await openDatabase(path.join(temporaryDirectory, "accounts.sqlite"));
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", createAuthRouter({ database, secret: "test-secret-that-is-at-least-32-bytes" }));
  httpServer = http.createServer(app);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${httpServer.address().port}/api/auth`;
});

after(async () => {
  await new Promise((resolve) => httpServer.close(resolve));
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
}

test("registers accounts, rejects invalid/duplicate data, manages sessions, and logs in", async () => {
  const invalid = await request("/register", {
    method: "POST",
    body: JSON.stringify({ name: "S", email: "bad-email", password: "short" }),
  });
  assert.equal(invalid.status, 400);

  const registration = await request("/register", {
    method: "POST",
    body: JSON.stringify({ name: "Srusti Jogalekar", email: "Srusti@example.com", password: "correct horse battery" }),
  });
  assert.equal(registration.status, 201);
  const { user } = await registration.json();
  assert.equal(user.name, "Srusti Jogalekar");
  assert.equal(user.email, "srusti@example.com");
  assert.ok(!("password" in user));
  const cookie = registration.headers.get("set-cookie");
  assert.match(cookie, /vmeet_session=.*HttpOnly/i);

  const session = await request("/me", { headers: { Cookie: cookie.split(";")[0] } });
  assert.equal((await session.json()).user.id, user.id);

  const duplicate = await request("/register", {
    method: "POST",
    body: JSON.stringify({ name: "Srusti Jogalekar", email: "SRUSTI@example.com", password: "correct horse battery" }),
  });
  assert.equal(duplicate.status, 409);

  const wrongPassword = await request("/login", {
    method: "POST",
    body: JSON.stringify({ email: "srusti@example.com", password: "wrong password" }),
  });
  assert.equal(wrongPassword.status, 401);

  const login = await request("/login", {
    method: "POST",
    body: JSON.stringify({ email: "SRUSTI@example.com", password: "correct horse battery" }),
  });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.id, user.id);

  const logout = await request("/logout", { method: "POST" });
  assert.equal(logout.status, 200);
});
