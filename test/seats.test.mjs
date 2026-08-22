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
  createDeskBrowserPool,
  createParkedChatGPTTab,
  deskHasChatGPTSession,
  deskJsonNewUrl,
  PARKED_WINDOW_X,
  pickUnclaimedChatGPTTarget,
  probeDeskSession,
  releaseReservedTarget,
  sessionFromProbe,
  targetIdFromJsonNew,
} from "../lib/cdp.mjs";
import { clientStreamMessage, keyEventParams, mouseEventParams, pointerToCdp } from "../lib/screencast.mjs";
import {
  TAB_PASTE_IMAGE_MAX,
  TAB_PASTE_NEED_FOCUS,
  applyTabPastePlan,
  classifyTabPaste,
  imagePasteExpression,
  interpretTabPasteEvaluate,
  tabPasteFromMessage,
  tabPastePlan,
} from "../lib/tab-paste.mjs";

function user(id, username) {
  return { id, username };
}

describe("seat assignment", () => {
  it("sends the first occupant to exclusive VNC when CDP is off", () => {
    const mode = decideOpenMode({ occupants: [], userId: "1", tabCount: 0, cap: 3 });
    assert.equal(mode.mode, "vnc");
    assert.equal(mode.attach, false);
  });

  it("gives the first occupant a tab when CDP is on", () => {
    const mode = decideOpenMode({ occupants: [], userId: "1", cdp: true, tabCount: 0, cap: 3 });
    assert.equal(mode.mode, "tab");
    assert.equal(mode.attach, false);
  });

  it("gives every concurrent first-open a tab when CDP is on", () => {
    const one = decideOpenMode({ occupants: [], userId: "1", cdp: true, tabCount: 0, cap: 3 });
    const two = decideOpenMode({ occupants: [], userId: "2", cdp: true, tabCount: 0, cap: 3 });
    const three = decideOpenMode({ occupants: [], userId: "3", cdp: true, tabCount: 0, cap: 3 });
    assert.equal(one.mode, "tab");
    assert.equal(two.mode, "tab");
    assert.equal(three.mode, "tab");
  });

  it("opens user1 then user2 then user3 as tabs when CDP is on", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const first = reg.decide("a", user("1", "ada"), { cdp: true });
    assert.equal(first.mode, "tab");
    reg.claim("a", user("1", "ada"), { mode: "tab", targetId: "t-ada" });
    const second = reg.decide("a", user("2", "bob"), { cdp: true });
    assert.equal(second.mode, "tab");
    reg.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob" });
    const third = reg.decide("a", user("3", "cyd"), { cdp: true });
    assert.equal(third.mode, "tab");
  });

  it("does not reattach a leftover VNC seat when CDP is on", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const leftover = reg.claim("a", user("1", "ada"), { mode: "vnc" });
    const decision = reg.decide("a", user("1", "ada"), { cdp: true });
    assert.equal(decision.mode, "tab");
    assert.equal(decision.attach, false);
    const upgraded = reg.claim("a", user("1", "ada"), { mode: "tab", targetId: "t-ada" });
    assert.equal(upgraded.id, leftover.id);
    assert.equal(upgraded.mode, "tab");
    assert.equal(upgraded.targetId, "t-ada");
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

  it("stores the member project URL on the seat for the jail", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const home = "https://chatgpt.com/g/g-p-aaa111-ada/project";
    const seat = reg.claim("a", user("1", "ada"), { mode: "tab", targetId: "t-ada", projectUrl: home });
    assert.equal(seat.projectUrl, home);
    const again = reg.claim("a", user("1", "ada"), { projectUrl: home });
    assert.equal(again.id, seat.id);
    assert.equal(again.projectUrl, home);
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
      (err) => err.code === "CDP_OFF" && err.status === 409 && err.message === "有人在使用",
    );
    assert.equal(multiUserOffError().message, "有人在使用");
    assert.throws(
      () => decideOpenMode({ occupants: [{ userId: "1" }], userId: "2", cdp: false }),
      (err) => err.code === multiUserOffError().code && err.message === "有人在使用",
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
    const pool = createDeskBrowserPool();
    const probe = await probeDeskSession("a", { fetchImpl, connect, pool });
    assert.equal(probe.known, false);
    assert.equal(probe.hasSession, null);
    assert.equal(await deskHasChatGPTSession("a", { fetchImpl, connect, pool }), null);
    const occupied = decideOpenMode({
      occupants: [{ userId: "1" }],
      userId: "2",
      cdp: true,
      hasSession: probe.hasSession,
    });
    assert.equal(occupied.mode, "tab");
  });

  it("reuses one /json/version and one browser WS for two tab creates", async () => {
    let versionHits = 0;
    let connects = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        versionHits += 1;
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      if (String(url).includes("/json")) throw new Error(`stampede ${url}`);
      throw new Error(`unexpected ${url}`);
    };
    const connect = () => {
      connects += 1;
      let creates = 0;
      return {
        ready: Promise.resolve(),
        ws: { readyState: 1, addEventListener() {} },
        async send(method) {
          if (method === "Target.createTarget") {
            creates += 1;
            return { targetId: `t-${creates}` };
          }
          if (method === "Browser.getWindowForTarget") return { windowId: 1 };
          if (method === "Browser.setWindowBounds") return {};
          throw new Error(method);
        },
        close() {},
      };
    };
    const pool = createDeskBrowserPool();
    const first = await createParkedChatGPTTab("a", { fetchImpl, connect, pool });
    const second = await createParkedChatGPTTab("a", { fetchImpl, connect, pool });
    assert.equal(first.targetId, "t-1");
    assert.equal(second.targetId, "t-2");
    assert.equal(versionHits, 1);
    assert.equal(connects, 1);
  });

  it("creates a tab via HTTP /json/new when Target.createTarget fails, without a second /json/version", async () => {
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
      ws: { readyState: 1, addEventListener() {} },
      async send() {
        throw new Error("无法连接页面");
      },
      close() {},
    });
    const created = await createParkedChatGPTTab("a", { fetchImpl, connect, pool: createDeskBrowserPool() });
    assert.equal(created.targetId, "t-http");
    assert.equal(calls.filter((c) => c.u.includes("/json/version")).length, 1);
    assert.equal(
      calls.some((c) => c.u.includes("/json/new") && (c.method === "PUT" || c.method === "GET")),
      true,
    );
    assert.match(deskJsonNewUrl("a"), /json\/new\?https%3A%2F%2Fchatgpt\.com/);
    assert.equal(targetIdFromJsonNew({ targetId: "from-cdp" }), "from-cdp");
  });

  it("creates a tab via /json/new when /json/version never answers", async () => {
    let versionHits = 0;
    const fetchImpl = async (url) => {
      const u = String(url);
      if (u.includes("/json/version")) {
        versionHits += 1;
        throw new Error("工作区还没准备好");
      }
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
      pool: createDeskBrowserPool(),
    });
    assert.equal(created.targetId, "t-new");
    assert.equal(versionHits, 1);
  });

  it("creates a background tab, not a new visible window", async () => {
    const creates = [];
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const connect = () => ({
      ready: Promise.resolve(),
      ws: { readyState: 1, addEventListener() {} },
      async send(method, params) {
        if (method === "Target.getTargets") return { targetInfos: [] };
        if (method === "Target.createTarget") {
          creates.push(params);
          return { targetId: "t-bg" };
        }
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        if (method === "Browser.setWindowBounds") return {};
        throw new Error(method);
      },
      close() {},
    });
    const created = await createParkedChatGPTTab("a", { fetchImpl, connect, pool: createDeskBrowserPool() });
    assert.equal(created.targetId, "t-bg");
    assert.equal(creates.length, 1);
    assert.equal(creates[0].newWindow, false);
    assert.equal(creates[0].background, true);
    releaseReservedTarget("a", "t-bg");
  });

  it("adopts an existing unclaimed ChatGPT target instead of opening a window", async () => {
    let creates = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const connect = () => ({
      ready: Promise.resolve(),
      ws: { readyState: 1, addEventListener() {} },
      async send(method) {
        if (method === "Target.getTargets") {
          return {
            targetInfos: [
              { targetId: "t-kiosk", type: "page", url: "https://chatgpt.com/" },
              { targetId: "t-other", type: "page", url: "https://example.com/" },
            ],
          };
        }
        if (method === "Target.createTarget") {
          creates += 1;
          return { targetId: "t-new" };
        }
        if (method === "Browser.getWindowForTarget") return { windowId: 9 };
        if (method === "Browser.setWindowBounds") return {};
        throw new Error(method);
      },
      close() {},
    });
    const created = await createParkedChatGPTTab("a", { fetchImpl, connect, pool: createDeskBrowserPool() });
    assert.equal(created.targetId, "t-kiosk");
    assert.equal(created.adopted, true);
    assert.equal(creates, 0);
    releaseReservedTarget("a", "t-kiosk");
  });

  it("does not adopt a ChatGPT target another seat already owns", async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    const connect = () => ({
      ready: Promise.resolve(),
      ws: { readyState: 1, addEventListener() {} },
      async send(method, params) {
        if (method === "Target.getTargets") {
          return { targetInfos: [{ targetId: "t-ada", type: "page", url: "https://chatgpt.com/" }] };
        }
        if (method === "Target.createTarget") return { targetId: "t-bob" };
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        if (method === "Browser.setWindowBounds") return {};
        throw new Error(`${method} ${JSON.stringify(params || {})}`);
      },
      close() {},
    });
    const created = await createParkedChatGPTTab("a", {
      fetchImpl,
      connect,
      pool: createDeskBrowserPool(),
      claimedTargetIds: ["t-ada"],
    });
    assert.equal(created.targetId, "t-bob");
    assert.equal(created.adopted, undefined);
    releaseReservedTarget("a", "t-bob");
  });

  it("picks only an unclaimed ChatGPT page as an adoptable target", () => {
    const targets = [
      { id: "t-ada", type: "page", url: "https://chatgpt.com/" },
      { id: "t-new", type: "page", url: "https://chatgpt.com/c/xyz" },
      { id: "browser", type: "browser" },
    ];
    assert.equal(pickUnclaimedChatGPTTarget(targets, { claimedTargetIds: ["t-ada"] })?.id, "t-new");
    assert.equal(pickUnclaimedChatGPTTarget(targets, { claimedTargetIds: ["t-ada", "t-new"] }), null);
  });

  it("does not let two concurrent creates adopt the same existing target", async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes("/json/version")) {
        return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/x" }) };
      }
      throw new Error(`unexpected ${url}`);
    };
    let creates = 0;
    const connect = () => ({
      ready: Promise.resolve(),
      ws: { readyState: 1, addEventListener() {} },
      async send(method) {
        if (method === "Target.getTargets") {
          return { targetInfos: [{ targetId: "t-kiosk", type: "page", url: "https://chatgpt.com/" }] };
        }
        if (method === "Target.createTarget") {
          creates += 1;
          return { targetId: `t-new-${creates}` };
        }
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        if (method === "Browser.setWindowBounds") return {};
        throw new Error(method);
      },
      close() {},
    });
    const pool = createDeskBrowserPool();
    const [first, second] = await Promise.all([
      createParkedChatGPTTab("race", { fetchImpl, connect, pool }),
      createParkedChatGPTTab("race", { fetchImpl, connect, pool }),
    ]);
    const ids = new Set([first.targetId, second.targetId]);
    assert.equal(ids.size, 2);
    assert.equal(ids.has("t-kiosk"), true);
    releaseReservedTarget("race", first.targetId);
    releaseReservedTarget("race", second.targetId);
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

describe("tab-seat paste plumbing", () => {
  it("classifies text, png/jpeg/webp, and rejects junk or oversized images", () => {
    assert.equal(classifyTabPaste("text/plain; charset=utf-8", 12).kind, "text");
    assert.equal(classifyTabPaste("image/png", 100).kind, "image");
    assert.equal(classifyTabPaste("image/jpg", 100).mime, "image/jpeg");
    assert.equal(classifyTabPaste("image/webp", 100).kind, "image");
    assert.equal(classifyTabPaste("image/gif", 100).status, 400);
    assert.equal(classifyTabPaste("image/png", TAB_PASTE_IMAGE_MAX + 1).status, 413);
    assert.equal(classifyTabPaste("text/plain", 0).status, 400);
  });

  it("plans text as Input.insertText and images as a focused ClipboardEvent", () => {
    const text = tabPastePlan("text/plain", Buffer.from("hello"));
    assert.equal(text.method, "Input.insertText");
    assert.equal(text.params.text, "hello");

    const png = tabPastePlan("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assert.equal(png.method, "Runtime.evaluate");
    const expr = png.params.expression;
    assert.match(expr, /ClipboardEvent/);
    assert.match(expr, /DataTransfer/);
    assert.match(expr, /document\.activeElement/);
    assert.match(expr, /isContentEditable/);
    assert.match(expr, /TEXTAREA/);
    assert.match(expr, /need-focus/);
    assert.doesNotMatch(expr, /querySelector|prosemirror|composer|prompt-textarea|chatgpt\.com/i);

    const fromWs = tabPasteFromMessage({ type: "paste", image: Buffer.from([1, 2, 3]).toString("base64"), mime: "image/jpeg" });
    assert.equal(fromWs.kind, "image");
    assert.equal(tabPasteFromMessage({ type: "paste", text: "hi" }).kind, "text");
  });

  it("maps a no-focus evaluate result to 点一下输入框再粘贴", () => {
    const miss = interpretTabPasteEvaluate({ ok: false, error: "need-focus" });
    assert.equal(miss.ok, false);
    assert.equal(miss.error, TAB_PASTE_NEED_FOCUS);
    assert.equal(miss.status, 400);
    assert.equal(interpretTabPasteEvaluate({ ok: true, kind: "image" }).ok, true);
  });

  it("applyTabPastePlan sends insertText for text and evaluate for images", async () => {
    const calls = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { value: { ok: true, kind: "image" } } };
      return {};
    };
    const textOut = await applyTabPastePlan(send, tabPastePlan("text/plain", Buffer.from("abc")));
    assert.equal(textOut.ok, true);
    assert.equal(textOut.kind, "text");
    assert.equal(calls[0].method, "Input.insertText");
    assert.equal(calls[0].params.text, "abc");

    const imgOut = await applyTabPastePlan(send, tabPastePlan("image/png", Buffer.from([9])));
    assert.equal(imgOut.ok, true);
    assert.equal(imgOut.kind, "image");
    assert.equal(calls[1].method, "Runtime.evaluate");

    const focusOut = await applyTabPastePlan(async () => ({ result: { value: { ok: false, error: "need-focus" } } }), {
      kind: "image",
      method: "Runtime.evaluate",
      params: { expression: imagePasteExpression({ mime: "image/png", base64: "AA==" }) },
    });
    assert.equal(focusOut.error, TAB_PASTE_NEED_FOCUS);
  });
});
