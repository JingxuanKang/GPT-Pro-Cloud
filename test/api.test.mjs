import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function cookieOf(res) {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return lines
    .map((line) => String(line).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function req(base, path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieOf(res) || cookie || "" };
}

function waitForLog(child, re, ms = 15000) {
  return new Promise((resolve, reject) => {
    const buf = { text: "" };
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${buf.text}`)), ms);
    const onData = (chunk) => {
      buf.text += chunk.toString();
      if (re.test(buf.text)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
        resolve(buf.text);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
}

describe("presence + kick API", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let ada;
  let adaCookie;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-api-"));
    const port = 18000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: join(dir, "users.json"),
        INSTANCES: "a,b",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLog(child, /gateway on/);
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }
    base = `http://127.0.0.1:${port}`;
    const login = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(login.status, 200);
    adminCookie = login.cookie;
    const created = await req(base, "/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "ada", password: "secret6", desks: ["a"] },
    });
    assert.equal(created.status, 200);
    ada = created.data.user;
    const member = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(member.status, 200);
    adaCookie = member.cookie;
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("lets admin see who is on which desk after a member opens it", async () => {
    const open = await req(base, "/api/desks/a/open", { method: "POST", cookie: adaCookie });
    assert.equal(open.status, 200);
    const beat = await req(base, "/api/presence/beat", { method: "POST", cookie: adaCookie, body: { deskId: "a" } });
    assert.equal(beat.status, 200);
    assert.equal(beat.data.viewers.some((v) => v.username === "ada" && v.id === ada.id), true);
    const adminBeat = await req(base, "/api/presence/beat", { method: "POST", cookie: adminCookie, body: { deskId: "b" } });
    assert.equal(adminBeat.status, 200);

    const adminView = await req(base, "/api/presence", { cookie: adminCookie });
    assert.equal(adminView.status, 200);
    const onA = adminView.data.presence.a || [];
    const onB = adminView.data.presence.b || [];
    assert.equal(onA.some((v) => v.id === ada.id && v.username === "ada"), true);
    assert.ok(onB.length);

    const memberView = await req(base, "/api/presence", { cookie: adaCookie });
    assert.equal(memberView.status, 200);
    assert.ok(memberView.data.presence.a);
    assert.equal(memberView.data.presence.b, undefined);
  });

  it("rejects kick from a member and keeps the account after admin kick", async () => {
    const admin = await req(base, "/api/me", { cookie: adminCookie });
    const forbidden = await req(base, `/api/admin/users/${admin.data.user.id}/kick`, { method: "POST", cookie: adaCookie });
    assert.equal(forbidden.status, 403);

    const kicked = await req(base, `/api/admin/users/${ada.id}/kick`, { method: "POST", cookie: adminCookie });
    assert.equal(kicked.status, 200);
    assert.equal(kicked.data.ok, true);
    assert.equal(kicked.data.user.disabled, false);
    assert.equal(kicked.data.user.username, "ada");
    assert.equal((kicked.data.presence.a || []).some((v) => v.id === ada.id), false);

    const dead = await req(base, "/api/me", { cookie: adaCookie });
    assert.equal(dead.status, 401);

    const still = await req(base, "/api/admin/users", { cookie: adminCookie });
    const row = still.data.users.find((u) => u.id === ada.id);
    assert.ok(row);
    assert.equal(row.disabled, false);

    const again = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(again.status, 200);
    assert.equal(again.data.user.disabled, false);

    const missing = await req(base, "/api/admin/users/not-a-user/kick", { method: "POST", cookie: adminCookie });
    assert.equal(missing.status, 404);
  });

  it("refuses to delete a compose seed desk and a missing extra desk", async () => {
    const seed = await req(base, "/api/admin/desks/a", { method: "DELETE", cookie: adminCookie });
    assert.equal(seed.status, 400);
    assert.match(seed.data.error || "", /内置/);
    const ghost = await req(base, "/api/admin/desks/c", { method: "DELETE", cookie: adminCookie });
    assert.equal(ghost.status, 404);
    const ada = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    const forbidden = await req(base, "/api/admin/desks/a", { method: "DELETE", cookie: ada.cookie });
    assert.equal(forbidden.status, 403);
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.data.desks.find((d) => d.id === "a").extra, false);
  });

  it("defaults CDP off, rejects a second occupant, and rejects page assist", async () => {
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);
    assert.equal(list.data.desks.find((d) => d.id === "b").cdp, false);

    const ada = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(ada.status, 200);
    const first = await req(base, "/api/desks/a/open", { method: "POST", cookie: ada.cookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.mode, "vnc");

    const created = await req(base, "/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "cyd", password: "secret6", desks: ["a"] },
    });
    assert.equal(created.status, 200);
    const cyd = await req(base, "/api/login", { method: "POST", body: { username: "cyd", password: "secret6" } });
    assert.equal(cyd.status, 200);
    const second = await req(base, "/api/desks/a/open", { method: "POST", cookie: cyd.cookie });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "该账号正在使用中");
    assert.equal(second.data.code, "CDP_OFF");

    const share = await req(base, "/api/desks/a/share", { method: "POST", cookie: ada.cookie });
    assert.equal(share.status, 403);
    assert.match(share.data.error || "", /调试口|多人/);
    const onboard = await req(base, "/api/desks/a/onboard", { method: "POST", cookie: ada.cookie });
    assert.equal(onboard.status, 403);
    assert.match(onboard.data.error || "", /调试口|多人/);

    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: true } });
    assert.equal(saved.status, 400);
    assert.match(saved.data.error || "", /多人分屏暂未开放/);
    const after = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(after.data.desks.find((d) => d.id === "a").cdp, false);
    assert.equal(after.data.desks.find((d) => d.id === "b").cdp, false);

    const off = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: false } });
    assert.equal(off.status, 200);
    assert.equal(off.data.cdp, false);

    const empty = await req(base, "/api/desks/a/files", { method: "POST", cookie: ada.cookie, body: { files: [] } });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.error, "空文件");
    const cancel = await req(base, "/api/desks/a/files", { method: "POST", cookie: ada.cookie, body: { cancel: true } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.data.kind, "cancel");
    const pdf = await req(base, "/api/desks/a/files", {
      method: "POST",
      cookie: ada.cookie,
      body: { files: [{ name: "a.pdf", mime: "application/pdf", data: Buffer.from("%PDF").toString("base64") }] },
    });
    assert.ok(pdf.status === 409 || pdf.status === 502);
    assert.doesNotMatch(pdf.data.error || "", /开启多人分屏|有人在使用/);
  });
});

describe("CDP lock ignores stored deskCdp=true", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let usersFile;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-cdp-lock-"));
    usersFile = join(dir, "users.json");
    writeFileSync(
      usersFile,
      JSON.stringify({
        users: [],
        deskCdp: { a: true, b: true },
      }),
    );
    const port = 18000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: usersFile,
        INSTANCES: "a,b",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await waitForLog(child, /gateway on/);
    } catch (err) {
      child.kill("SIGTERM");
      throw err;
    }
    base = `http://127.0.0.1:${port}`;
    const login = await req(base, "/api/login", { method: "POST", body: { username: "admin", password: "admin-secret" } });
    assert.equal(login.status, 200);
    adminCookie = login.cookie;
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("opens exclusive VNC, rejects a second occupant, and rejects enable", async () => {
    const stored = JSON.parse(readFileSync(usersFile, "utf8"));
    assert.equal(stored.deskCdp.a, true);

    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);

    const first = await req(base, "/api/desks/a/open", { method: "POST", cookie: adminCookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.mode, "vnc");

    const created = await req(base, "/api/admin/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "ada", password: "secret6", desks: ["a"] },
    });
    assert.equal(created.status, 200);
    const ada = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(ada.status, 200);
    const second = await req(base, "/api/desks/a/open", { method: "POST", cookie: ada.cookie });
    assert.equal(second.status, 409);
    assert.equal(second.data.error, "该账号正在使用中");
    assert.equal(second.data.code, "CDP_OFF");

    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: true } });
    assert.equal(saved.status, 400);
    assert.match(saved.data.error || "", /多人分屏暂未开放/);
    const after = JSON.parse(readFileSync(usersFile, "utf8"));
    assert.equal(after.deskCdp.a, true);
  });
});
