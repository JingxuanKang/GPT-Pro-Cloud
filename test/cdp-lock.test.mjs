import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createUserStore } from "../lib/users.mjs";
import { decideOpenMode, createSeatRegistry, multiUserOffError } from "../lib/seats.mjs";
import { CHATGPT_START } from "../lib/cdp.mjs";
import { seatStartUrl } from "../lib/project-jail.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_MSG = "多人分屏暂未开放";
const PROJECT_HOME = "https://chatgpt.com/g/g-p-aaa111-ada/project";

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

function seedUsersFile(file, extra = {}) {
  writeFileSync(
    file,
    JSON.stringify({
      users: [],
      deskCdp: { a: true, b: true },
      deskNames: { a: "Phoenix A" },
      ...extra,
    }),
  );
}

function storedCdp(file, id = "a") {
  return !!JSON.parse(readFileSync(file, "utf8")).deskCdp?.[id];
}

describe("CDP lock — deskCdpOn ignores stored true", () => {
  it("returns false for every desk when users.json still has deskCdp true", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-lock-store-"));
    const file = join(dir, "users.json");
    seedUsersFile(file);
    const store = createUserStore({
      file,
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
    assert.equal(store.deskCdpOn("a"), false);
    assert.equal(store.deskCdpOn("b"), false);
    assert.equal(store.deskCdpOn("missing"), false);
    assert.equal(store.assistOn("a"), false);
    assert.equal(storedCdp(file, "a"), true);
    assert.equal(storedCdp(file, "b"), true);
  });
});

describe("CDP lock — setDeskCdp", () => {
  it("rejects turning a desk on with the formal Chinese lock message", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-lock-set-"));
    const store = createUserStore({
      file: join(dir, "users.json"),
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
    assert.throws(() => store.setDeskCdp("a", true), (err) => err.message === LOCK_MSG);
    assert.equal(store.deskCdpOn("a"), false);
  });

  it("treats setDeskCdp(false) as a no-op and does not wipe stored flags", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-lock-off-"));
    const file = join(dir, "users.json");
    seedUsersFile(file);
    const store = createUserStore({
      file,
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
    assert.equal(store.setDeskCdp("a", false), false);
    assert.equal(store.deskCdpOn("a"), false);
    assert.equal(storedCdp(file, "a"), true);
  });
});

describe("CDP lock — exclusive VNC decision", () => {
  it("sends the first occupant to exclusive VNC when the lock forces cdp off", () => {
    const first = decideOpenMode({ occupants: [], userId: "1", cdp: false });
    assert.equal(first.mode, "vnc");
    assert.equal(first.attach, false);
  });

  it("rejects a second occupant with 409 CDP_OFF when cdp is off", () => {
    const reg = createSeatRegistry({ cap: 3 });
    reg.claim("a", { id: "1", username: "ada" }, { mode: "vnc" });
    assert.throws(
      () => reg.decide("a", { id: "2", username: "bob" }, { cdp: false }),
      (err) =>
        err.code === "CDP_OFF" &&
        err.status === 409 &&
        err.code === multiUserOffError().code &&
        err.message === "该账号正在使用中",
    );
  });

  it("does not start a tab seat or project URL when cdp is off", () => {
    assert.equal(seatStartUrl({ cdp: false, projectUrl: PROJECT_HOME }), CHATGPT_START);
    assert.equal(seatStartUrl({ cdp: false, projectUrl: "" }), CHATGPT_START);
  });
});

describe("CDP lock — settings UI", () => {
  it("omits the abandoned 多人分屏 card and any 暂未开放 copy", () => {
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const settingsStart = ui.indexOf("function renderSettings");
    const settingsBlock = ui.slice(settingsStart, ui.indexOf("const isMac", settingsStart));
    assert.doesNotMatch(settingsBlock, /多人分屏/);
    assert.doesNotMatch(settingsBlock, /暂未开放/);
    assert.match(settingsBlock, /<b>复制粘贴<\/b>/);
    assert.match(settingsBlock, /<b>出口代理<\/b>/);
    assert.doesNotMatch(settingsBlock, /data-cdp-toggle|checkbox|switch-row|cdp-rows|cdp-empty/);
    assert.doesNotMatch(settingsBlock, /data-cdp-master|cdp-master/);
    assert.doesNotMatch(ui, /data-cdp-toggle/);
    const deskCdpOnFn = ui.slice(ui.indexOf("function deskCdpOn"), ui.indexOf("function route"));
    assert.match(deskCdpOnFn, /return false/);
    assert.doesNotMatch(deskCdpOnFn, /state\.desks/);
  });
});

describe("CDP lock — share / jail / onboard stay gated", () => {
  it("does not arm jail, kickOnboard, share, or page-assist unless cdp is on", () => {
    const gw = readFileSync(resolve(root, "gateway/server.mjs"), "utf8");
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const openStart = gw.indexOf("const open = url.pathname.match(/^\\/api\\/desks\\/([a-z0-9-]+)\\/open$/)");
    const openBlock = gw.slice(openStart, gw.indexOf("const paste = url.pathname.match"));
    assert.match(openBlock, /const cdp = users\.deskCdpOn\(id\)/);
    assert.equal([...openBlock.matchAll(/armSeatProjectJail\(/g)].length, 1);
    assert.match(openBlock, /if \(cdp && projectUrl\) armSeatProjectJail/);
    assert.equal([...openBlock.matchAll(/kickOnboard\(/g)].length, 1);
    assert.match(openBlock, /if \(cdp\) kickOnboard/);
    assert.match(openBlock, /watchExclusiveFileChooser/);
    assert.doesNotMatch(openBlock, /if \(cdp\) watchExclusiveFileChooser/);
    assert.match(openBlock, /const projectUrl = cdp \? users\.projectUrlOn/);
    assert.match(gw, /if \(!users\.deskCdpOn\(id\)\) return json\(res, 403/);
    assert.match(ui, /deskCdpOn\(state\.deskId\) \? `<button type="button" class="chrome-btn" id="share-chat"/);
    assert.match(ui, /if \(deskCdpOn\(state\.deskId\)\) ensureWorkspace\(\)/);
    const deskCdpOnFn = ui.slice(ui.indexOf("function deskCdpOn"), ui.indexOf("function route"));
    assert.match(deskCdpOnFn, /return false/);
  });
});

describe("CDP lock — gateway with stored deskCdp=true", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let usersFile;
  let adaCookie;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-cdp-lock-suite-"));
    usersFile = join(dir, "users.json");
    const store = createUserStore({
      file: usersFile,
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
    store.renameDesk("a", "Phoenix A");
    const ada = store.create({ username: "ada", password: "secret6", desks: ["a"] });
    store.update(ada.id, {
      projectReady: true,
      projectName: "ada",
      projectDesk: "a",
      projectUrl: PROJECT_HOME,
    });
    const data = JSON.parse(readFileSync(usersFile, "utf8"));
    data.deskCdp = { a: true, b: true };
    writeFileSync(usersFile, JSON.stringify(data, null, 2));
    const port = 20000 + Math.floor(Math.random() * 2000);
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
    const member = await req(base, "/api/login", { method: "POST", body: { username: "ada", password: "secret6" } });
    assert.equal(member.status, 200);
    adaCookie = member.cookie;
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("lists every desk as cdp false while the stored flag stays true", async () => {
    assert.equal(storedCdp(usersFile, "a"), true);
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);
    assert.equal(list.data.desks.find((d) => d.id === "b").cdp, false);
    assert.equal(storedCdp(usersFile, "a"), true);
  });

  it("rejects PATCH cdp true with 4xx and the formal Chinese lock message", async () => {
    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: true } });
    assert.ok(saved.status >= 400 && saved.status < 500);
    assert.equal(saved.data.error, LOCK_MSG);
    assert.equal(storedCdp(usersFile, "a"), true);
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);
  });

  it("accepts PATCH cdp false as a no-op without wiping stored flags", async () => {
    const off = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: false } });
    assert.equal(off.status, 200);
    assert.equal(off.data.cdp, false);
    assert.equal(storedCdp(usersFile, "a"), true);
  });

  it("rejects a mixed rename + enable PATCH without renaming the desk", async () => {
    const before = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(before.data.desks.find((d) => d.id === "a").name, "Phoenix A");
    const mixed = await req(base, "/api/admin/desks/a", {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "Should Not Stick", cdp: true },
    });
    assert.ok(mixed.status >= 400 && mixed.status < 500);
    assert.equal(mixed.data.error, LOCK_MSG);
    const after = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(after.data.desks.find((d) => d.id === "a").name, "Phoenix A");
  });

  it("rejects a member PATCH that tries to enable CDP", async () => {
    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adaCookie, body: { cdp: true } });
    assert.equal(saved.status, 403);
    assert.equal(storedCdp(usersFile, "a"), true);
  });

  it("opens the first occupant on exclusive VNC, not a tab, even with a stored project URL", async () => {
    const me = await req(base, "/api/me", { cookie: adaCookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.projectUrls.a, PROJECT_HOME);
    const first = await req(base, "/api/desks/a/open", { method: "POST", cookie: adaCookie });
    assert.equal(first.status, 200);
    assert.equal(first.data.mode, "vnc");
    assert.equal(first.data.seat?.mode, "vnc");
    assert.equal(first.data.seat?.targetId, undefined);
    assert.notEqual(first.data.mode, "tab");
  });

  it("lets the same occupant re-attach the exclusive VNC seat", async () => {
    const again = await req(base, "/api/desks/a/open", { method: "POST", cookie: adaCookie });
    assert.equal(again.status, 200);
    assert.equal(again.data.mode, "vnc");
    assert.equal(again.data.seat?.mode, "vnc");
  });

  it("rejects share and onboard page-assist while the lock is on", async () => {
    const share = await req(base, "/api/desks/a/share", { method: "POST", cookie: adaCookie });
    assert.equal(share.status, 403);
    assert.match(share.data.error || "", /调试口|多人/);
    const onboard = await req(base, "/api/desks/a/onboard", { method: "POST", cookie: adaCookie });
    assert.equal(onboard.status, 403);
    assert.match(onboard.data.error || "", /调试口|多人/);
  });

  it("rejects a second occupant with 409 CDP_OFF", async () => {
    const second = await req(base, "/api/desks/a/open", { method: "POST", cookie: adminCookie });
    assert.equal(second.status, 409);
    assert.equal(second.data.code, "CDP_OFF");
    assert.equal(second.data.error, "该账号正在使用中");
  });
});
