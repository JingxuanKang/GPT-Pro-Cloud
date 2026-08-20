import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSessionStore } from "../lib/auth.mjs";
import { createPresence } from "../lib/presence.mjs";
import { createSocketHub, kickLiveSession } from "../lib/kick.mjs";
import {
  createSeatRegistry,
  decideOpenMode,
  DEFAULT_TAB_SEAT_CAP,
  parseTabSeatCap,
  publicSeat,
  targetsVisibleToSeat,
} from "../lib/seats.mjs";
import { cookiesIndicateChatGPTSession, PARKED_WINDOW_X } from "../lib/cdp.mjs";
import { clientStreamMessage, keyEventParams, mouseEventParams, pointerToCdp } from "../lib/screencast.mjs";

function user(id, username) {
  return { id, username };
}

describe("seat assignment", () => {
  it("sends the first occupant without cookies to VNC", () => {
    const mode = decideOpenMode({ occupants: [], userId: "1", hasSession: false, tabCount: 0, cap: 3 });
    assert.equal(mode.mode, "vnc");
    assert.equal(mode.attach, false);
  });

  it("keeps the first occupant on VNC after ChatGPT login when the desk is empty", () => {
    const mode = decideOpenMode({ occupants: [], userId: "1", hasSession: true, tabCount: 0, cap: 3 });
    assert.equal(mode.mode, "vnc");
  });

  it("assigns a new tab seat when the account is already occupied and cookies exist", () => {
    const mode = decideOpenMode({
      occupants: [{ userId: "1" }],
      userId: "2",
      hasSession: true,
      tabCount: 0,
      cap: 3,
    });
    assert.equal(mode.mode, "tab");
    assert.equal(mode.attach, false);
  });

  it("reattaches the same member to their existing seat instead of opening another tab", () => {
    const reg = createSeatRegistry({ cap: 3 });
    const first = reg.claim("a", user("1", "ada"), { mode: "tab", targetId: "t-ada" });
    const decision = reg.decide("a", user("1", "ada"), { hasSession: true });
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
    const next = reg.decide("a", user("2", "bob"), { hasSession: true });
    assert.equal(next.mode, "tab");
    reg.claim("a", user("2", "bob"), { mode: "tab", targetId: "t-bob" });
    assert.equal(reg.tabCount("a"), 1);
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
      () => decideOpenMode({ occupants: [{ userId: "1" }, { userId: "2" }, { userId: "3" }], userId: "4", hasSession: true, tabCount: 2, cap: 2 }),
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
    assert.equal(PARKED_WINDOW_X <= -1000, true);
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
