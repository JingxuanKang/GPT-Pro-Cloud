import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
    const u = store.update(m.id, {
      projectReady: true,
      projectName: "bob",
      projectDesk: "a",
      projectUrl: "https://chatgpt.com/g/g-p-bbb222-bob/c/x",
    });
    assert.equal(u.projectReady, true);
    assert.equal(u.projectName, "bob");
    assert.equal(u.projectUrls.a, "https://chatgpt.com/g/g-p-bbb222-bob/project");
    assert.equal(store.get(m.id).projectReady, true);
    assert.equal(store.projectUrlOn(m.id, "a"), "https://chatgpt.com/g/g-p-bbb222-bob/project");
    assert.equal(store.readyOn(m.id, "a"), true);
    assert.equal(store.readyOn(m.id, "b"), false);
    assert.equal(store.projectUrlOn(m.id, "b"), "");
  });

  it("creates on a second desk even if the first desk is ready", () => {
    const m = store.create({ username: "cara", password: "secret6", desks: ["a", "b"] });
    store.update(m.id, { projectDesk: "a", projectName: "cara" });
    assert.equal(store.readyOn(m.id, "a"), true);
    assert.equal(store.readyOn(m.id, "b"), false);
    const u = store.update(m.id, { projectDesk: "b" });
    assert.equal(u.projectDesks.b, true);
    assert.equal(store.readyOn(m.id, "b"), true);
    assert.equal(store.projectUrlOn(m.id, "b"), "");
    store.update(m.id, {
      projectDesk: "b",
      projectUrl: "https://chatgpt.com/g/g-p-ccc333-cara/project",
    });
    assert.equal(store.readyOn(m.id, "b"), true);
    assert.equal(store.projectUrlOn(m.id, "b"), "https://chatgpt.com/g/g-p-ccc333-cara/project");
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
    assert.deepEqual(
      p.list("a", 1000).map((x) => x.id).sort(),
      ["1", "2"],
    );
    assert.deepEqual(p.desksOf("1", 1000), ["a"]);
    assert.equal(p.list("a", 1000 + 30_000).length, 0);
  });

  it("keeps per-desk CDP / multi-user off until an admin turns it on", () => {
    assert.equal(store.deskCdpOn("a"), false);
    assert.equal(store.deskCdpOn("b"), false);
    assert.equal(store.assistOn("a"), false);
    assert.deepEqual(store.settings(), {});
    assert.equal(store.setDeskCdp("a", true), true);
    assert.equal(store.deskCdpOn("a"), true);
    assert.equal(store.assistOn("a"), true);
    assert.equal(store.deskCdpOn("b"), false);
    assert.equal(store.setDeskCdp("a", false), false);
    assert.equal(store.deskCdpOn("a"), false);
    assert.throws(() => store.setDeskCdp("zz", true), /账号不存在/);
  });

  it("does not treat a leftover global settings.assist as turning CDP on", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-assist-"));
    const file = join(dir, "users.json");
    writeFileSync(
      file,
      JSON.stringify({
        users: [],
        settings: { assist: true },
        deskCdp: { a: true, ghost: true },
      }),
    );
    const s = createUserStore({ file, adminUser: "admin", adminPassword: "admin-secret", deskIds: ["a", "b"] });
    assert.equal(s.deskCdpOn("a"), true);
    assert.equal(s.deskCdpOn("b"), false);
    assert.equal(s.assistOn("b"), false);
    assert.deepEqual(s.settings(), {});
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

  it("stores a per-desk proxy and validates the scheme", () => {
    assert.equal(store.deskProxyOf("a"), "");
    store.setDeskProxy("a", "socks5://10.0.0.2:1080");
    assert.equal(store.deskProxyOf("a"), "socks5://10.0.0.2:1080");
    store.setDeskProxy("a", "");
    assert.equal(store.deskProxyOf("a"), "");
    assert.throws(() => store.setDeskProxy("a", "ftp://x"), /代理格式/);
    assert.throws(() => store.setDeskProxy("zz", "http://x:1"), /账号不存在/);
  });

  it("remembers saved proxies and applies one to every desk", () => {
    store.setDeskProxy("a", "http://127.0.0.1:7890");
    store.setDeskProxy("b", "socks5://10.0.0.2:1080");
    assert.deepEqual(store.proxyPresets(), ["socks5://10.0.0.2:1080", "http://127.0.0.1:7890"]);
    const all = store.setAllDeskProxies("http://127.0.0.1:7890");
    assert.equal(all, "http://127.0.0.1:7890");
    assert.equal(store.deskProxyOf("a"), "http://127.0.0.1:7890");
    assert.equal(store.deskProxyOf("b"), "http://127.0.0.1:7890");
    assert.deepEqual(store.proxyPresets(), ["http://127.0.0.1:7890", "socks5://10.0.0.2:1080"]);
    store.setAllDeskProxies("");
    assert.equal(store.deskProxyOf("a"), "");
    assert.equal(store.deskProxyOf("b"), "");
    assert.ok(store.proxyPresets().includes("socks5://10.0.0.2:1080"));
    assert.throws(() => store.setAllDeskProxies("ftp://x"), /代理格式/);
  });

  it("reloads proxy presets from users.json and hydrates from deskProxies", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-proxy-"));
    const file = join(dir, "users.json");
    const a = createUserStore({ file, adminUser: "admin", adminPassword: "admin-secret", deskIds: ["a", "b"] });
    a.setDeskProxy("a", "http://10.0.0.8:7890");
    a.setAllDeskProxies("socks5://10.0.0.9:1080");
    const b = createUserStore({ file, adminUser: "admin", adminPassword: "admin-secret", deskIds: ["a", "b"] });
    assert.equal(b.deskProxyOf("a"), "socks5://10.0.0.9:1080");
    assert.equal(b.deskProxyOf("b"), "socks5://10.0.0.9:1080");
    assert.deepEqual(b.proxyPresets(), ["socks5://10.0.0.9:1080", "http://10.0.0.8:7890"]);
  });

  it("persists an extra desk across reload and grants it to admin", () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-desk-"));
    const file = join(dir, "users.json");
    const a = createUserStore({ file, adminUser: "admin", adminPassword: "admin-secret", deskIds: ["a", "b"] });
    const saved = a.addDesk("c", "客户号");
    assert.deepEqual(saved, { id: "c", name: "客户号" });
    assert.deepEqual(a.listDeskIds(), ["a", "b", "c"]);
    assert.deepEqual(a.extraDeskIds(), ["c"]);
    assert.equal(a.deskNameOf("c"), "客户号");
    const admin = a.login("admin", "admin-secret");
    assert.ok(a.canOpen(admin, "c"));
    assert.deepEqual(admin.desks, ["a", "b", "c"]);
    const m = a.create({ username: "erin", password: "secret6", desks: ["c"] });
    assert.deepEqual(m.desks, ["c"]);
    assert.equal(a.canOpen(m, "c"), true);
    assert.equal(a.canOpen(m, "a"), false);
    assert.equal(a.deskCdpOn("c"), false);
    a.setDeskCdp("c", true);
    const b = createUserStore({ file, adminUser: "admin", adminPassword: "admin-secret", deskIds: ["a", "b"] });
    assert.deepEqual(b.listDeskIds(), ["a", "b", "c"]);
    assert.deepEqual(b.extraDeskIds(), ["c"]);
    assert.equal(b.deskNameOf("c"), "客户号");
    assert.equal(b.deskCdpOn("c"), true);
    assert.ok(b.canOpen(b.login("admin", "admin-secret"), "c"));
    assert.throws(() => a.addDesk("c", "重复"), /已存在/);
    assert.throws(() => a.addDesk("Bad_ID", "x"), /不合法/);
    a.setAllDeskProxies("http://127.0.0.1:7890");
    assert.equal(a.deskProxyOf("c"), "http://127.0.0.1:7890");
    assert.equal(a.deskProxyOf("a"), "http://127.0.0.1:7890");
    assert.equal(a.isExtraDesk("c"), true);
    assert.equal(a.isExtraDesk("a"), false);
    a.removeDesk("c");
    assert.equal(a.deskCdpOn("c"), false);
    assert.deepEqual(a.listDeskIds(), ["a", "b"]);
    assert.deepEqual(a.extraDeskIds(), []);
    assert.equal(a.deskNameOf("c"), "");
    assert.equal(a.canOpen(a.login("admin", "admin-secret"), "c"), false);
    assert.equal(a.canOpen(a.login("erin", "secret6"), "c"), false);
    assert.throws(() => a.removeDesk("a"), /内置/);
    assert.throws(() => a.removeDesk("missing"), /不存在/);
  });

  it("clears a user from every desk", () => {
    const p = createPresence();
    const ada = { id: "1", username: "ada" };
    p.beat("a", ada, 1000);
    p.beat("b", ada, 1000);
    p.leaveAll("1");
    assert.equal(p.list("a", 1000).length, 0);
    assert.equal(p.list("b", 1000).length, 0);
    p.beat("a", ada, 1000);
    p.clear("a");
    assert.equal(p.list("a", 1000).length, 0);
  });
});
