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

function storedCdp(file, id = "a") {
  return !!JSON.parse(readFileSync(file, "utf8")).deskCdp?.[id];
}

describe("CDP off — exclusive VNC decision", () => {
  it("sends the first occupant to exclusive VNC when cdp is off", () => {
    const first = decideOpenMode({ occupants: [], userId: "1", cdp: false });
    assert.equal(first.mode, "vnc");
    assert.equal(first.attach, false);
  });

  it("rejects a second occupant with 409 CDP_OFF when cdp is off", () => {
    const reg = createSeatRegistry({ cap: 3 });
    reg.claim("a", { id: "1", username: "ada" }, { mode: "vnc" });
    assert.throws(
      () => reg.decide("a", { id: "2", username: "bob" }, { cdp: false }),
      (err) => err.code === "CDP_OFF" && err.status === 409 && err.code === multiUserOffError().code,
    );
  });

  it("does not start a tab seat or project URL when cdp is off", () => {
    assert.equal(seatStartUrl({ cdp: false, projectUrl: PROJECT_HOME }), CHATGPT_START);
    assert.equal(seatStartUrl({ cdp: false, projectUrl: "" }), CHATGPT_START);
  });
});

describe("CDP off — settings UI", () => {
  it("shows 多人分屏暂未开放 and has no working toggle", () => {
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const settingsStart = ui.indexOf("function renderSettings");
    const settingsBlock = ui.slice(settingsStart, ui.indexOf("const isMac", settingsStart));
    const panel = settingsBlock.slice(settingsBlock.indexOf("<b>多人分屏</b>"), settingsBlock.indexOf("<b>复制粘贴</b>"));
    assert.match(panel, /多人分屏暂未开放/);
    assert.doesNotMatch(panel, /data-cdp-toggle/);
    assert.doesNotMatch(ui, /data-cdp-toggle/);
    const deskCdpOnFn = ui.slice(ui.indexOf("function deskCdpOn"), ui.indexOf("function route"));
    assert.match(deskCdpOnFn, /return false/);
    assert.doesNotMatch(deskCdpOnFn, /state\.desks/);
  });
});

describe("CDP off — share / jail / onboard stay gated", () => {
  it("does not arm jail, share, or page-assist unless cdp is on", () => {
    const gw = readFileSync(resolve(root, "gateway/server.mjs"), "utf8");
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const openStart = gw.indexOf("const open = url.pathname.match(/^\\/api\\/desks\\/([a-z0-9-]+)\\/open$/)");
    const openBlock = gw.slice(openStart, gw.indexOf("const paste = url.pathname.match"));
    assert.match(openBlock, /const cdp = users\.deskCdpOn\(id\)/);
    assert.doesNotMatch(openBlock, /deskHasChatGPTSession/);
    assert.match(openBlock, /allocateTabSeatTarget/);
    assert.match(openBlock, /hasSession: null/);
    assert.equal([...openBlock.matchAll(/armSeatProjectJail\(/g)].length, 1);
    assert.match(openBlock, /if \(cdp && sess\.user\.role !== "admin" && projectUrl\) armSeatProjectJail/);
    assert.doesNotMatch(openBlock, /kickOnboard/);
    assert.match(gw, /if \(!users\.deskCdpOn\(id\)\) return json\(res, 403/);
    assert.match(ui, /deskCdpOn\(state\.deskId\) \? `<button type="button" class="chrome-btn" id="share-chat"/);
    assert.match(ui, /if \(deskCdpOn\(state\.deskId\) && state\.me\?\.role !== "admin" && state\.deskMode === "tab"\) ensureWorkspace\(\)/);
    const deskCdpOnFn = ui.slice(ui.indexOf("function deskCdpOn"), ui.indexOf("function route"));
    assert.match(deskCdpOnFn, /return false/);
  });
});

describe("CDP off — gateway with split-screen disabled", { concurrency: 1 }, () => {
  let child;
  let base;
  let adminCookie;
  let usersFile;
  let adaCookie;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-cdp-off-suite-"));
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

  it("lists every desk as cdp false when the stored flag is off", async () => {
    assert.equal(storedCdp(usersFile, "a"), false);
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);
    assert.equal(list.data.desks.find((d) => d.id === "b").cdp, false);
  });

  it("ignores a stored deskCdp=true flag after reload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-cdp-stored-"));
    const file = join(dir, "users.json");
    writeFileSync(file, JSON.stringify({ users: [], deskCdp: { a: true } }));
    const store = createUserStore({
      file,
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
    assert.equal(store.deskCdpOn("a"), false);
    assert.equal(store.deskCdpOn("b"), false);
  });

  it("refuses PATCH cdp true with 多人分屏暂未开放", async () => {
    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: true } });
    assert.equal(saved.status, 409);
    assert.match(saved.data.error || "", /暂未开放/);
    assert.equal(saved.data.code, "SPLIT_SCREEN_DISABLED");
    assert.equal(storedCdp(usersFile, "a"), false);
    const list = await req(base, "/api/desks", { cookie: adminCookie });
    assert.equal(list.data.desks.find((d) => d.id === "a").cdp, false);
  });

  it("accepts PATCH cdp false while the switch is already off", async () => {
    const off = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adminCookie, body: { cdp: false } });
    assert.equal(off.status, 200);
    assert.equal(off.data.cdp, false);
    assert.equal(storedCdp(usersFile, "a"), false);
  });

  it("rejects a member PATCH that tries to enable CDP", async () => {
    const saved = await req(base, "/api/admin/desks/a", { method: "PATCH", cookie: adaCookie, body: { cdp: true } });
    assert.equal(saved.status, 403);
    assert.equal(storedCdp(usersFile, "a"), false);
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

  it("rejects share and onboard page-assist while split-screen is off", async () => {
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
    assert.match(second.data.error || "", /未开多人分屏/);
  });
});
