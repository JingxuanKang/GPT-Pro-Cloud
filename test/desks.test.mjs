import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserStore } from "../lib/users.mjs";
import { parseInstances } from "../lib/instances.mjs";
import { createDeskRegistry, nextDeskId, provisionDesk, MAX_DESKS } from "../lib/desks.mjs";

describe("desk ids", () => {
  it("allocates the next letter after a and b", () => {
    assert.equal(nextDeskId(["a", "b"]), "c");
    assert.equal(nextDeskId(["a", "b", "c"]), "d");
  });

  it("wraps to letter+number after z", () => {
    const letters = [..."abcdefghijklmnopqrstuvwxyz"];
    assert.equal(nextDeskId(letters), "a2");
    assert.equal(nextDeskId([...letters, "a2"]), "b2");
  });
});

describe("desk registry", () => {
  it("keeps seed a/b and registers a new target", () => {
    const registry = createDeskRegistry(parseInstances("a,b"));
    assert.deepEqual(registry.ids(), ["a", "b"]);
    const c = registry.add("c");
    assert.equal(c.target, "http://desktop-c:3000");
    assert.equal(registry.has("c"), true);
    assert.equal(registry.get("a").target, "http://desktop-a:3000");
    assert.equal(registry.add("c"), c);
  });
});

describe("provisionDesk", () => {
  function store() {
    const dir = mkdtempSync(join(tmpdir(), "gpc-prov-"));
    return createUserStore({
      file: join(dir, "users.json"),
      adminUser: "admin",
      adminPassword: "admin-secret",
      deskIds: ["a", "b"],
    });
  }

  it("starts the container before writing a card", async () => {
    const users = store();
    const registry = createDeskRegistry(parseInstances("a,b"));
    const started = [];
    const desk = await provisionDesk({
      users,
      registry,
      name: "客户号",
      ensure: async (id) => {
        started.push(id);
      },
    });
    assert.deepEqual(started, ["c"]);
    assert.deepEqual(desk, { id: "c", name: "客户号" });
    assert.deepEqual(users.extraDeskIds(), ["c"]);
    assert.equal(registry.has("c"), true);
  });

  it("does not persist a card when the container fails to start", async () => {
    const users = store();
    const registry = createDeskRegistry(parseInstances("a,b"));
    await assert.rejects(
      () =>
        provisionDesk({
          users,
          registry,
          name: "失败号",
          ensure: async () => {
            const e = new Error("找不到模板桌面");
            e.status = 502;
            throw e;
          },
        }),
      /找不到模板桌面/,
    );
    assert.deepEqual(users.extraDeskIds(), []);
    assert.equal(registry.has("c"), false);
    assert.deepEqual(users.listDeskIds(), ["a", "b"]);
  });

  it("accepts an explicit id and rejects a duplicate", async () => {
    const users = store();
    const registry = createDeskRegistry(parseInstances("a,b"));
    const desk = await provisionDesk({
      users,
      registry,
      name: "销售号",
      id: "sales",
      ensure: async () => {},
    });
    assert.equal(desk.id, "sales");
    await assert.rejects(
      () => provisionDesk({ users, registry, name: "又一个", id: "sales", ensure: async () => {} }),
      /已存在/,
    );
    await assert.rejects(() => provisionDesk({ users, registry, name: "", ensure: async () => {} }), /名字/);
  });

  it("caps the number of desks", async () => {
    const users = store();
    const registry = createDeskRegistry(parseInstances("a,b"));
    await assert.rejects(
      () => provisionDesk({ users, registry, name: "太多", maxDesks: 2, ensure: async () => {} }),
      /最多 2/,
    );
    assert.equal(MAX_DESKS, 24);
  });
});
