import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeatRegistry, decideOpenMode } from "../lib/seats.mjs";
import { withDeadline } from "../lib/cdp.mjs";
import { allocateTabSeatTarget, memberCdpMustBeTab, OPEN_CDP_MS, OPEN_FAIL } from "../lib/tab-open.mjs";

function user(id, username) {
  return { id, username, role: "member" };
}

describe("concurrent member open", () => {
  it("gives two concurrent first-opens distinct tab targets and never VNC", async () => {
    const seats = createSeatRegistry({ cap: 3 });
    let n = 0;
    const reserved = new Set();
    const run = (who) =>
      allocateTabSeatTarget({
        deskId: "a",
        user: who,
        projectUrl: `https://chatgpt.com/g/g-p-${who.id}-x/project`,
        startUrl: "https://chatgpt.com",
        seats,
        targetExists: async () => false,
        findParked: async () => null,
        createParked: async () => ({ targetId: `t-${++n}` }),
        reserveTarget: (_desk, id) => {
          if (reserved.has(id)) return false;
          reserved.add(id);
          return true;
        },
      });
    const ada = user("1", "ada");
    const bob = user("2", "bob");
    const [one, two] = await Promise.all([run(ada), run(bob)]);
    assert.notEqual(one.targetId, two.targetId);
    const a = seats.claim("a", ada, { mode: "tab", targetId: one.targetId });
    const b = seats.claim("a", bob, { mode: "tab", targetId: two.targetId });
    assert.equal(a.mode, "tab");
    assert.equal(b.mode, "tab");
    assert.notEqual(a.targetId, b.targetId);
    assert.equal(decideOpenMode({ occupants: [{ userId: "1" }], userId: "2", cdp: true }).mode, "tab");
    assert.equal(memberCdpMustBeTab(true, "member", "vnc"), false);
    assert.equal(memberCdpMustBeTab(true, "member", "tab"), true);
  });

  it("does not let two members adopt the same parked target", async () => {
    const seats = createSeatRegistry({ cap: 3 });
    const reserved = new Set();
    let creates = 0;
    const run = (who) =>
      allocateTabSeatTarget({
        deskId: "a",
        user: who,
        projectUrl: "https://chatgpt.com/g/g-p-aaa111-ada/project",
        startUrl: "https://chatgpt.com",
        seats,
        targetExists: async () => false,
        findParked: async () => ({ id: "t-shared" }),
        createParked: async () => ({ targetId: `t-new-${++creates}` }),
        reserveTarget: (_desk, id) => {
          if (reserved.has(id)) return false;
          reserved.add(id);
          return true;
        },
      });
    const [one, two] = await Promise.all([run(user("1", "ada")), run(user("2", "bob"))]);
    assert.equal(new Set([one.targetId, two.targetId]).size, 2);
    assert.equal([one.targetId, two.targetId].includes("t-shared"), true);
    assert.equal(creates, 1);
  });

  it("reuses a live parked seat without createTarget", async () => {
    const seats = createSeatRegistry({ cap: 3 });
    const ada = user("1", "ada");
    const existing = seats.claim("a", ada, { mode: "tab", targetId: "t-warm" });
    const got = await allocateTabSeatTarget({
      deskId: "a",
      user: ada,
      projectUrl: "https://chatgpt.com/g/g-p-aaa111-ada/project",
      seats,
      existing,
      targetExists: async (_d, id) => id === "t-warm",
      findParked: async () => {
        throw new Error("should not list");
      },
      createParked: async () => {
        throw new Error("should not create");
      },
    });
    assert.deepEqual(got, { targetId: "t-warm", reused: true });
  });

  it("two concurrent /open allocations are tab seats with distinct targets, never VNC", async () => {
    const seats = createSeatRegistry({ cap: 3 });
    let n = 0;
    const ada = user("1", "ada");
    const bob = user("2", "bob");
    const [one, two] = await Promise.all([
      allocateTabSeatTarget({
        deskId: "desk",
        user: ada,
        projectUrl: "https://chatgpt.com/g/g-p-aaa111-ada/project",
        seats,
        targetExists: async () => false,
        findParked: async () => null,
        createParked: async () => ({ targetId: `tab-${++n}` }),
        reserveTarget: () => true,
      }),
      allocateTabSeatTarget({
        deskId: "desk",
        user: bob,
        projectUrl: "https://chatgpt.com/g/g-p-bbb222-bob/project",
        seats,
        targetExists: async () => false,
        findParked: async () => null,
        createParked: async () => ({ targetId: `tab-${++n}` }),
        reserveTarget: () => true,
      }),
    ]);
    const a = seats.claim("desk", ada, { mode: "tab", targetId: one.targetId });
    const b = seats.claim("desk", bob, { mode: "tab", targetId: two.targetId });
    assert.equal(a.mode, "tab");
    assert.equal(b.mode, "tab");
    assert.notEqual(a.targetId, b.targetId);
    assert.equal(a.targetId.startsWith("tab-"), true);
    assert.equal(memberCdpMustBeTab(true, "member", a.mode), true);
    assert.equal(memberCdpMustBeTab(true, "member", "vnc"), false);
  });

  it("fails a hung debugger instead of hanging /open", async () => {
    assert.equal(OPEN_CDP_MS <= 4000, true);
    await assert.rejects(
      () => withDeadline(new Promise(() => {}), 20, OPEN_FAIL),
      (err) => err.message === OPEN_FAIL,
    );
  });
});
