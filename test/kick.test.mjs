import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "../lib/auth.mjs";
import { createPresence } from "../lib/presence.mjs";
import { createSocketHub, kickLiveSession } from "../lib/kick.mjs";

class FakeSocket extends EventEmitter {
  destroy() {
    this.destroyed = true;
    this.emit("close");
  }
}

describe("kick live session", () => {
  it("revokes sessions, clears presence, and drops sockets without touching the account", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-kick-"));
    const sessions = createSessionStore({ file: join(dir, "sessions.json"), ttlMs: 60_000, flushEveryMs: 60_000 });
    sessions.set("tok-ada", { userId: "1", expires: Date.now() + 60_000 });
    sessions.set("tok-bob", { userId: "2", expires: Date.now() + 60_000 });
    const presence = createPresence();
    presence.beat("a", { id: "1", username: "ada" }, 1000);
    presence.beat("b", { id: "1", username: "ada" }, 1000);
    presence.beat("a", { id: "2", username: "bob" }, 1000);
    const sockets = createSocketHub();
    const desk = new FakeSocket();
    sockets.add("1", desk);

    const dropped = kickLiveSession({ sessions, presence, sockets }, "1");
    assert.equal(dropped.sessions, 1);
    assert.equal(dropped.sockets, 1);
    assert.equal(desk.destroyed, true);
    assert.equal(sessions.get("tok-ada"), undefined);
    assert.ok(sessions.get("tok-bob"));
    assert.equal(presence.list("a", 1000).length, 1);
    assert.equal(presence.list("a", 1000)[0].username, "bob");
    assert.equal(presence.list("b", 1000).length, 0);
    assert.deepEqual(presence.desksOf("1", 1000), []);
  });

  it("is a no-op for a missing user id", () => {
    const sessions = createSessionStore({ ttlMs: 60_000 });
    const presence = createPresence();
    const sockets = createSocketHub();
    assert.deepEqual(kickLiveSession({ sessions, presence, sockets }, ""), {
      sessions: 0,
      sockets: 0,
      seats: 0,
      released: [],
    });
    assert.deepEqual(kickLiveSession({ sessions, presence, sockets }, "ghost"), {
      sessions: 0,
      sockets: 0,
      seats: 0,
      released: [],
    });
  });
});

describe("presence visibility", () => {
  it("exposes who is on which desk with user ids", () => {
    const p = createPresence();
    p.beat("a", { id: "1", username: "ada" }, 2000);
    p.beat("b", { id: "2", username: "bob" }, 2000);
    const all = p.all(2000);
    assert.equal(all.a[0].id, "1");
    assert.equal(all.a[0].username, "ada");
    assert.equal(all.b[0].id, "2");
    assert.deepEqual(p.desksOf("2", 2000), ["b"]);
  });
});
