import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../lib/auth.mjs";
import { createPresence } from "../lib/presence.mjs";
import { createSocketHub, kickLiveSession } from "../lib/kick.mjs";
import {
  createSeatRegistry,
  decideOpenMode,
  DEFAULT_TAB_SEAT_CAP,
  multiUserOffError,
  parseTabSeatCap,
  publicSeat,
  targetsVisibleToSeat,
} from "../lib/seats.mjs";
import {
  cookiesIndicateChatGPTSession,
  createParkedChatGPTTab,
  deskHasChatGPTSession,
  deskJsonNewUrl,
  PARKED_WINDOW_X,
  probeDeskSession,
  sessionFromProbe,
  targetIdFromJsonNew,
} from "../lib/cdp.mjs";
import { clientStreamMessage, keyEventParams, mouseEventParams, pointerToCdp } from "../lib/screencast.mjs";

function user(id, username) {
  return { id, username };
}

describe("seat assignment", () => {
  it("sends the first occupant to exclusive VNC", () => {
    const mode = decideOpenMode({ occupants: [], userId: "1", tabCount: 0, cap: 3 });
    assert.equal(mode.mode, "vnc");
    assert.equal(mode.attach, false);
  });

  it("keeps the first occupant on VNC when the desk is empty even if CDP is on", () => {
    const mode = decideOpenMode({ occupants: [], userId: "1", cdp: true, tabCount: 0, cap: 3 });
    assert.equal(mode.mode, "vnc");
  });

  it("assigns a new tab seat when CDP is on and the account is already occupied", () => {
    const mode = decideOpenMode({
      occupants: [{ userId: "1" }],
      userId: "2",
      cdp: true,
      tabCount: 0,
      cap: 3,
    });
    assert.equal(mode.mode, "tab");
    assert.equal(mode.attach, false);
  });

  it("gives a tab when occupied even if the CDP session check fails", () => {
    const probe = sessionFromProbe({ error: new Error("无法连接页面") });
    assert.equal(probe.known, false);
    assert.equal(probe.hasSession, null);
    const mode = decideOpenMode({
      occupants: [{ userId: "1" }],
      userId: "2",
      cdp: true,
      hasSession: probe.hasSession,
      tabCount: 0,
      cap: 3,
    });
    assert.equal(mode.mode, "tab");
    assert.notEqual(mode.mode, "vnc");
  });

  it("does not let a failed cookie probe force a second VNC", () => {
    const mode = decideOpenMode({
      occupants: [{ userId: "1" }],
      userId: "2",
      cdp: true,
      hasSession: false,
      tabCount: 0,
      cap: 3,
    });
    assert.equal(mode.mode, "tab");
  });

  it("uses presence as occupancy when the first member is still beating", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const next = reg.decide("a", user("2", "bob"), {
      cdp: true,
      hasSession: null,
      extraOccupants: [{ userId: "1" }],
    });
    assert.equal(next.mode, "tab");
    assert.equal(next.attach, false);
  });

  it("reattaches the same member to their existing seat instead of opening another tab", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const first = reg.claim("a", user("1", "ada"), { mode: "tab", targetId: "t-ada" });
    const decision = reg.decide("a", user("1", "ada"), { cdp: true });
    assert.equal(decision.attach, true);
    assert.equal(decision.mode, "tab");
    const again = reg.claim("a", user("1", "ada"), { mode: "tab" });
    assert.equal(again.id, first.id);
    assert.equal(again.targetId, "t-ada");
    assert.equal(reg.tabCount("a"), 1);
  });

  it("does not treat a VNC occupant as consuming a tab seat", () => {
    const reg = createSeatRegistry({ cap: 2 });
    reg.claim("a", user("1", "ada"), { mode: "vnc" });
    const next = reg.decide("a", user("2", "bob"), { cdp: true });
    assert.equal(next.mode, "tab");
    reg.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob" });
    assert.equal(reg.tabCount("a"), 1);
  });

  it("rejects a second occupant when CDP / 多人分屏 is off", () => {
    const reg = createSeatRegistry({ cap: 3 });
    reg.claim("a", user("1", "ada"), { mode: "vnc" });
    assert.throws(
      () => reg.decide("a", user("2", "bob"), { cdp: false }),
      (err) => err.code === "CDP_OFF" && err.status === 409 && /未开多人分屏/.test(err.message),
    );
    assert.throws(
      () => decideOpenMode({ occupants: [{ userId: "1" }], userId: "2", cdp: false }),
      (err) => err.code === multiUserOffError().code,
    );
  });
});

describe("cannot see other targets", () => {
  it("publicSeat never includes targetId or debugger URLs", () => {
    const pub = publicSeat({
      id: "s1",
      deskId: "a",
      mode: "tab",
      userId: "1",
      username: "ada",
      targetId: "SECRET-TARGET",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/SECRET",
    });
    const raw = JSON.stringify(pub);
    assert.equal(raw.includes("SECRET"), false);
    assert.equal(raw.includes("9222"), false);
    assert.equal(raw.includes("ws://"), false);
    assert.equal(pub.id, "s1");
    assert.equal(pub.mode, "tab");
  });

  it("filters the target list to the assigned seat only", () => {
    const seat = { id: "s1", targetId: "t-ada" };
    const targets = [
      { id: "t-ada", type: "page", url: "https://chatgpt.com/", webSocketDebuggerUrl: "ws://hidden/ada" },
      { id: "t-bob", type: "page", url: "https://chatgpt.com/c/xyz", webSocketDebuggerUrl: "ws://hidden/bob" },
      { id: "browser", type: "browser" },
    ];
    assert.deepEqual(targetsVisibleToSeat(seat, targets), [{ id: "t-ada", type: "page" }]);
    assert.deepEqual(targetsVisibleToSeat({ id: "s2" }, targets), []);
  });

  it("client stream frames never carry other targets", () => {
    const frame = clientStreamMessage({
      type: "frame",
      data: "abc",
      metadata: { deviceWidth: 800, deviceHeight: 600 },
      targetId: "t-bob",
      targets: [{ id: "t-ada" }, { id: "t-bob" }],
    });
    const raw = JSON.stringify(frame);
    assert.equal(frame.type, "frame");
    assert.equal(raw.includes("t-bob"), false);
    assert.equal(raw.includes("t-ada"), false);
    assert.equal(clientStreamMessage({ type: "ready", targetId: "nope" }).mode, "tab");
    assert.equal(JSON.stringify(clientStreamMessage({ type: "ready", targetId: "nope" })).includes("nope"), false);
  });
});

describe("disconnect one tab", () => {
  it("releaseByUser closes only that member's tab seat", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const ada = reg.claim("a", user("1", "ada"), { mode: "vnc" });
    const bob = reg.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob" });
    const cyd = reg.claim("a", user("3", "cyd"), { mode: "tab", targetId: "t-cyd" });
    const dropped = reg.releaseByUser("2");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].id, bob.id);
    assert.equal(dropped[0].targetId, "t-bob");
    assert.ok(reg.get(ada.id));
    assert.ok(reg.get(cyd.id));
    assert.equal(reg.get(bob.id), undefined);
    assert.equal(reg.tabCount("a"), 1);
  });

  it("kick drops one member's tab seat and leaves the other tab and the desk", () => {
    const sessions = createSessionStore({ ttlMs: 60_000 });
    sessions.set("tok-bob", { userId: "2", expires: Date.now() + 60_000 });
    sessions.set("tok-cyd", { userId: "3", expires: Date.now() + 60_000 });
    const presence = createPresence();
    presence.beat("a", user("2", "bob"), 1000);
    presence.beat("a", user("3", "cyd"), 1000);
    const sockets = createSocketHub();
    const seats = createSeatRegistry({ cap: 3 });
    seats.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob" });
    const cyd = seats.claim("a", user("3", "cyd"), { mode: "tab", targetId: "t-cyd" });

    const dropped = kickLiveSession({ sessions, presence, sockets, seats }, "2");
    assert.equal(dropped.sessions, 1);
    assert.equal(dropped.seats, 1);
    assert.equal(dropped.released[0].targetId, "t-bob");
    assert.ok(sessions.get("tok-cyd"));
    assert.equal(presence.list("a", 1000).some((v) => v.username === "cyd"), true);
    assert.equal(presence.list("a", 1000).some((v) => v.username === "bob"), false);
    assert.ok(seats.get(cyd.id));
    assert.equal(seats.ofUser("a", "2"), undefined);
  });

  it("idle tabs can be closed without touching a live seat", () => {
    const reg = createSeatRegistry({ cap: 3, idleMs: 1000 });
    reg.claim("a", user("1", "ada"), { mode: "tab", targetId: "t-ada", now: 0 });
    const bob = reg.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob", now: 5000 });
    const idle = reg.idleTabs(5000);
    assert.equal(idle.length, 1);
    assert.equal(idle[0].username, "ada");
    reg.release(idle[0].id);
    assert.ok(reg.get(bob.id));
    assert.equal(reg.tabCount("a"), 1);
  });
});

describe("occupancy cap", () => {
  it("defaults to 3 concurrent tab seats and parses TAB_SEATS_MAX", () => {
    assert.equal(DEFAULT_TAB_SEAT_CAP, 3);
    assert.equal(parseTabSeatCap("4"), 4);
    assert.equal(parseTabSeatCap("0"), 3);
    assert.equal(parseTabSeatCap("99"), 3);
    assert.equal(parseTabSeatCap("nope"), 3);
  });

  it("rejects a new tab when the occupancy cap is reached", () => {
    const reg = createSeatRegistry({ cap: 2 });
    reg.claim("a", user("1", "ada"), { mode: "vnc" });
    reg.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob" });
    reg.claim("a", user("3", "cyd"), { mode: "tab", targetId: "t-cyd" });
    assert.throws(
      () => decideOpenMode({ occupants: [{ userId: "1" }, { userId: "2" }, { userId: "3" }], userId: "4", cdp: true, tabCount: 2, cap: 2 }),
      (err) => err.code === "SEAT_CAP" && err.status === 409,
    );
    assert.throws(
      () => reg.claim("a", user("4", "dan"), { mode: "tab", targetId: "t-dan" }),
      (err) => err.code === "SEAT_CAP",
    );
    assert.equal(reg.tabCount("a"), 2);
  });
});

describe("session cookies and input mapping", () => {
  it("treats ChatGPT session-token cookies as a signed-in account", () => {
    assert.equal(cookiesIndicateChatGPTSession([]), false);
    assert.equal(cookiesIndicateChatGPTSession([{ name: "__Host-next-auth.csrf-token", domain: "chatgpt.com" }]), false);
    assert.equal(
      cookiesIndicateChatGPTSession([{ name: "__Secure-next-auth.session-token", domain: ".chatgpt.com" }]),
      true,
    );
    assert.equal(
      cookiesIndicateChatGPTSession([
        { name: "__Secure-next-auth.session-token.0" },
        { name: "__Secure-next-auth.session-token.1" },
      ]),
      true,
    );
    const named = sessionFromProbe({
      cookies: [{ name: "__Secure-next-auth.session-token.0" }],
      error: new Error("无法连接页面"),
    });
    assert.equal(named.known, true);
    assert.equal(named.hasSession, true);
    assert.equal(PARKED_WINDOW_X <= -1000, true);
  });

  it("treats a busy debugger as unknown session, not logged-out", async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      throw new Error("no");
    };
    const connect = () => {
      const err = new Error("无法连接页面");
      return {
        ready: Promise.reject(err),
        send() {
          return Promise.reject(err);
        },
        close() {},
      };
    };
    const probe = await probeDeskSession("a", { fetchImpl, connect });
    assert.equal(probe.known, false);
    assert.equal(probe.hasSession, null);
    assert.equal(await deskHasChatGPTSession("a", { fetchImpl, connect }), null);
    const occupied = decideOpenMode({
      occupants: [{ userId: "1" }],
      userId: "2",
      cdp: true,
      hasSession: probe.hasSession,
    });
    assert.equal(occupied.mode, "tab");
  });

  it("retries parked-tab create after /json/version is briefly down", async () => {
    let versionHits = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        versionHits += 1;
        if (versionHits < 3) {
          const err = new Error("timeout");
          err.name = "TimeoutError";
          throw err;
        }
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const connect = () => ({
      ready: Promise.resolve(),
      async send(method) {
        if (method === "Target.createTarget") return { targetId: "t-retry" };
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        if (method === "Browser.setWindowBounds") return {};
        throw new Error(method);
      },
      close() {},
    });
    const created = await createParkedChatGPTTab("a", { fetchImpl, connect, timeoutMs: 3000, retryMs: 10 });
    assert.equal(created.targetId, "t-retry");
    assert.ok(versionHits >= 3);
  });

  it("creates a tab via HTTP /json/new when the browser debugger is busy", async () => {
    const calls = [];
    const fetchImpl = async (url, opts = {}) => {
      const u = String(url);
      calls.push({ u, method: opts.method || "GET" });
      if (u.includes("/json/version")) {
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      if (u.includes("/json/new")) {
        return { ok: true, json: async () => ({ id: "t-http", type: "page" }) };
      }
      throw new Error(`unexpected ${u}`);
    };
    const connect = () => ({
      ready: Promise.resolve(),
      async send() {
        throw new Error("无法连接页面");
      },
      close() {},
    });
    const created = await createParkedChatGPTTab("a", { fetchImpl, connect, timeoutMs: 2000, retryMs: 10 });
    assert.equal(created.targetId, "t-http");
    assert.equal(
      calls.some((c) => c.u.includes("/json/new") && (c.method === "PUT" || c.method === "GET")),
      true,
    );
    assert.match(deskJsonNewUrl("a"), /json\/new\?https%3A%2F%2Fchatgpt\.com/);
    assert.equal(targetIdFromJsonNew({ targetId: "from-cdp" }), "from-cdp");
  });

  it("creates a tab via /json/new when /json/version never answers", async () => {
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes("/json/version")) throw new Error("工作区还没准备好");
      if (u.includes("/json/new")) return { ok: true, json: async () => ({ id: "t-new" }) };
      throw new Error(u);
    };
    const created = await createParkedChatGPTTab("a", {
      fetchImpl,
      connect: () => ({
        ready: Promise.reject(new Error("no")),
        send: async () => ({}),
        close() {},
      }),
      timeoutMs: 1500,
      retryMs: 10,
    });
    assert.equal(created.targetId, "t-new");
  });

  it("maps pointer and key events into CDP Input params", () => {
    const pos = pointerToCdp(64, 40, { width: 128, height: 80 }, { deviceWidth: 1280, deviceHeight: 800 });
    assert.equal(pos.x, 640);
    assert.equal(pos.y, 400);
    const mouse = mouseEventParams({ event: "mousePressed", x: 64, y: 40, button: "left" }, { width: 128, height: 80 }, { deviceWidth: 1280, deviceHeight: 800 });
    assert.equal(mouse.type, "mousePressed");
    assert.equal(mouse.x, 640);
    const key = keyEventParams({ event: "keyDown", key: "a", code: "KeyA" });
    assert.equal(key.type, "keyDown");
    assert.equal(key.text, "a");
  });
});
