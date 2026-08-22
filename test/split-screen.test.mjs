import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserStore } from "../lib/users.mjs";
import { decideOpenMode } from "../lib/seats.mjs";
import {
  CHATGPT_NOT_LOGGED_IN,
  EXISTING_DEFAULT_MEMORY,
  PROJECT_ONLY_REQUIRED,
  SPLIT_SCREEN_DISABLED,
  SPLIT_SCREEN_DISABLED_MSG,
  WORKSPACE_NOT_READY,
  acceptOnboardResult,
  assignDesksWithProjects,
  exclusiveOccupied,
  removedDesks,
  lockMemberToStoredProject,
  memberOpenDecision,
  renameMemberWithProjects,
  runEnableJob,
} from "../lib/split-screen.mjs";

const ADA = "https://chatgpt.com/g/g-p-aaa111-ada/project";

function store() {
  return createUserStore({
    file: join(mkdtempSync(join(tmpdir(), "gpc-ss-")), "users.json"),
    adminUser: "admin",
    adminPassword: "admin-secret",
    deskIds: ["a", "b"],
  });
}

describe("enable job", () => {
  it("refuses to enable because split-screen is withdrawn", async () => {
    const users = store();
    users.create({ username: "ada", password: "secret6", desks: ["a"] });
    const apply = [];
    const created = [];
    const r = await runEnableJob({
      deskId: "a",
      users,
      occupied: false,
      applyCdp: async (on) => apply.push(on),
      persistCdp: (on) => users.setDeskCdp("a", on),
      hasSession: async () => true,
      createProject: async (_id, member) => {
        created.push(member.username);
        return { ok: true, url: ADA, memory: "project-only" };
      },
    });
    assert.equal(SPLIT_SCREEN_DISABLED, true);
    assert.equal(r.ok, false);
    assert.equal(r.status, 409);
    assert.equal(r.error, SPLIT_SCREEN_DISABLED_MSG);
    assert.equal(users.deskCdpOn("a"), false);
    assert.deepEqual(apply, []);
    assert.deepEqual(created, []);
    assert.throws(() => users.setDeskCdp("a", true), /多人分屏暂未开放/);
  });
});

describe("assign while split-screen is withdrawn", () => {
  it("lists desks a member lost so leftover seat windows can close", () => {
    assert.deepEqual(removedDesks(["a", "b"], ["a"]), ["b"]);
    assert.deepEqual(removedDesks(["a"], ["a", "b"]), []);
  });

  it("assigns a CDP-off desk without creating a project", async () => {
    const users = store();
    const ada = users.create({ username: "ada", password: "secret6", desks: [] });
    const created = [];
    const r = await assignDesksWithProjects({
      user: ada,
      nextDesks: ["a"],
      users,
      hasSession: async () => true,
      createProject: async () => {
        created.push("a");
        return { ok: true, url: ADA, memory: "project-only" };
      },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(users.get(ada.id).desks, ["a"]);
    assert.deepEqual(created, []);
  });
});

describe("member open does not create", () => {
  it("returns 工作区未就绪 and never creates when the URL is missing", () => {
    const users = store();
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    let created = 0;
    const r = lockMemberToStoredProject({
      user: ada,
      deskId: "a",
      users,
      createProject: () => {
        created += 1;
        return { ok: true, url: ADA, memory: "project-only" };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, WORKSPACE_NOT_READY);
    assert.equal(r.created, false);
    assert.equal(created, 0);
  });

  it("uses the stored member project URL", () => {
    const users = store();
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    users.update(ada.id, { projectDesk: "a", projectUrl: ADA, projectName: "ada" });
    const r = lockMemberToStoredProject({ user: users.get(ada.id), deskId: "a", users });
    assert.equal(r.ok, true);
    assert.equal(r.url, ADA);
    assert.equal(r.created, false);
  });

  it("blocks members when the ChatGPT session is gone and keeps CDP on", () => {
    const gate = memberOpenDecision({
      cdp: true,
      role: "member",
      projectUrl: ADA,
      hasSession: false,
    });
    assert.equal(gate.ok, false);
    assert.equal(gate.error, CHATGPT_NOT_LOGGED_IN);
    assert.equal(memberOpenDecision({ cdp: true, role: "admin", hasSession: false }).ok, true);
  });
});

describe("admin open is VNC even when CDP is on", () => {
  it("gives the admin the uncut desktop", () => {
    const mode = decideOpenMode({ occupants: [], userId: "admin", cdp: true, role: "admin" });
    assert.equal(mode.mode, "vnc");
    assert.equal(mode.attach, false);
    const withMembers = decideOpenMode({
      occupants: [{ userId: "1" }, { userId: "2" }],
      userId: "admin",
      cdp: true,
      role: "admin",
      tabCount: 2,
    });
    assert.equal(withMembers.mode, "vnc");
  });
});

describe("onboard result contract", () => {
  it("rejects a create that did not confirm project-only memory", () => {
    assert.equal(acceptOnboardResult({ ok: true, url: ADA }).ok, false);
    assert.equal(acceptOnboardResult({ ok: true, url: ADA }).error, PROJECT_ONLY_REQUIRED);
    assert.equal(acceptOnboardResult({ ok: true, url: ADA, memory: "default" }).error, EXISTING_DEFAULT_MEMORY);
    assert.equal(acceptOnboardResult({ ok: true, url: ADA, memory: "project-only" }).url, ADA);
  });
});

describe("exclusive occupancy", () => {
  it("treats a VNC or tab seat as occupied", () => {
    assert.equal(exclusiveOccupied({ seats: { list: () => [{ mode: "vnc" }] }, deskId: "a" }), true);
    assert.equal(exclusiveOccupied({ seats: { list: () => [] }, presence: { list: () => [{ id: "1" }] }, deskId: "a" }), true);
    assert.equal(exclusiveOccupied({ seats: { list: () => [] }, presence: { list: () => [] }, deskId: "a" }), false);
  });
});

describe("rename", () => {
  it("renames without creating a project while split-screen is off", async () => {
    const users = store();
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    users.update(ada.id, { projectDesk: "a", projectUrl: ADA, projectName: "ada" });
    let created = 0;
    const r = await renameMemberWithProjects({
      user: users.get(ada.id),
      username: "ada2",
      users,
      hasSession: async () => true,
      createProject: async () => {
        created += 1;
        return { ok: false, error: PROJECT_ONLY_REQUIRED };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(created, 0);
    assert.equal(users.get(ada.id).username, "ada2");
    assert.equal(users.projectUrlOn(ada.id, "a"), ADA);
  });
});
