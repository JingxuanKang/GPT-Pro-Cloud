import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserStore } from "../lib/users.mjs";
import { createPresence } from "../lib/presence.mjs";

describe("users + presence", () => {
  let store;
  before(() => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-users-"));
    store = createUserStore({
      file: join(dir, "users.json"),
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
  });

  it("boots an admin and rejects a bad password", () => {
    assert.equal(store.login("admin", "nope"), null);
    const u = store.login("admin", "admin-secret");
    assert.ok(u);
    assert.equal(u.role, "admin");
    assert.ok(store.canOpen(u, "a"));
  });

  it("lets admin create a member bound to one desk", () => {
    const m = store.create({ username: "ada", password: "secret6", desks: ["a"] });
    assert.equal(m.username, "ada");
    assert.deepEqual(m.desks, ["a"]);
    assert.equal(store.canOpen(m, "a"), true);
    assert.equal(store.canOpen(m, "b"), false);
    assert.equal(store.login("ada", "secret6").id, m.id);
    assert.equal(m.projectReady, false);
  });

  it("marks a member project ready after first desk open", () => {
    const m = store.create({ username: "bob", password: "secret6", desks: ["a"] });
    const u = store.update(m.id, { projectReady: true, projectName: "bob", projectDesk: "a" });
    assert.equal(u.projectReady, true);
    assert.equal(u.projectName, "bob");
    assert.equal(store.get(m.id).projectReady, true);
    assert.equal(store.readyOn(m.id, "a"), true);
    assert.equal(store.readyOn(m.id, "b"), false);
  });

  it("creates on a second desk even if the first desk is ready", () => {
    const m = store.create({ username: "cara", password: "secret6", desks: ["a", "b"] });
    store.update(m.id, { projectDesk: "a", projectName: "cara" });
    assert.equal(store.readyOn(m.id, "a"), true);
    assert.equal(store.readyOn(m.id, "b"), false);
    const u = store.update(m.id, { projectDesk: "b" });
    assert.equal(u.projectDesks.b, true);
    assert.equal(store.readyOn(m.id, "b"), true);
  });

  it("tracks who is on a desk", () => {
    const p = createPresence();
    const ada = { id: "1", username: "ada" };
    const bob = { id: "2", username: "bob" };
    p.beat("a", ada, 1000);
    p.beat("a", bob, 1000);
    assert.deepEqual(
      p.list("a", 1000).map((x) => x.username).sort(),
      ["ada", "bob"],
    );
    assert.equal(p.list("a", 1000 + 30_000).length, 0);
  });

  it("keeps page assist off until an admin turns it on", () => {
    assert.equal(store.assistOn(), false);
    assert.deepEqual(store.settings(), { assist: false });
    const on = store.setSettings({ assist: true });
    assert.equal(on.assist, true);
    assert.equal(store.assistOn(), true);
    store.setSettings({ assist: false });
    assert.equal(store.assistOn(), false);
  });

  it("lets admin reset a password, revoke desks and disable login", () => {
    const m = store.create({ username: "dora", password: "secret6", desks: ["a", "b"] });
    store.update(m.id, { desks: ["b"], password: "newpass6" });
    assert.equal(store.login("dora", "secret6"), null);
    const u = store.login("dora", "newpass6");
    assert.deepEqual(u.desks, ["b"]);
    store.update(m.id, { disabled: true });
    assert.equal(store.login("dora", "newpass6"), null);
    store.update(m.id, { disabled: false });
    assert.ok(store.login("dora", "newpass6"));
  });

  it("renames a desk for everyone and clears back to the default", () => {
    assert.equal(store.deskNameOf("a"), "");
    store.renameDesk("a", "老板号");
    assert.equal(store.deskNameOf("a"), "老板号");
    store.renameDesk("a", "  ");
    assert.equal(store.deskNameOf("a"), "");
    assert.throws(() => store.renameDesk("zz", "x"), /账号不存在/);
    assert.throws(() => store.renameDesk("a", "x".repeat(25)), /24/);
  });

  it("boots without an admin and creates one via the setup path", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-setup-"));
    const s = createUserStore({ file: join(dir, "users.json"), adminUser: "admin", adminPassword: "", deskIds: ["a"] });
    assert.equal(s.hasAdmin(), false);
    assert.equal(s.login("admin", "anything"), null);
    const admin = s.createAdmin({ username: "boss", password: "secret6" });
    assert.equal(admin.role, "admin");
    assert.deepEqual(admin.desks, ["a"]);
    assert.equal(s.hasAdmin(), true);
    assert.throws(() => s.createAdmin({ username: "b2", password: "secret6" }), /已存在/);
    assert.ok(s.login("boss", "secret6"));
  });

  it("clears a user from every desk", () => {
    const p = createPresence();
    const ada = { id: "1", username: "ada" };
    p.beat("a", ada, 1000);
    p.beat("b", ada, 1000);
    p.leaveAll("1");
    assert.equal(p.list("a", 1000).length, 0);
    assert.equal(p.list("b", 1000).length, 0);
  });
});
