import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserStore } from "../lib/users.mjs";
import { decideOpenMode } from "../lib/seats.mjs";
import {
  CHATGPT_NOT_LOGGED_IN,
  ENABLE_OCCUPIED,
  EXISTING_DEFAULT_MEMORY,
  PROJECT_ONLY_REQUIRED,
  SESSION_UNKNOWN,
  WORKSPACE_NOT_READY,
  acceptOnboardResult,
  assignDesksWithProjects,
  exclusiveOccupied,
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
  it("fails when ChatGPT is not logged in and leaves the switch off", async () => {
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
      hasSession: async () => false,
      createProject: async (_id, member) => {
        created.push(member.username);
        return { ok: true, url: ADA, memory: "project-only" };
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, CHATGPT_NOT_LOGGED_IN);
    assert.equal(users.deskCdpOn("a"), false);
    assert.deepEqual(apply, [true, false]);
    assert.deepEqual(created, []);
  });

  it("fails when a member cannot get project-only memory and keeps the switch off", async () => {
    const users = store();
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    users.create({ username: "bob", password: "secret6", desks: ["a"] });
    const apply = [];
    const r = await runEnableJob({
      deskId: "a",
      users,
      occupied: false,
      applyCdp: async (on) => apply.push(on),
      persistCdp: (on) => users.setDeskCdp("a", on),
      hasSession: async () => true,
      createProject: async (_id, member) => {
        if (member.username === "ada") return { ok: true, url: ADA, memory: "project-only" };
        return { ok: false, error: PROJECT_ONLY_REQUIRED };
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /bob|仅项目/);
    assert.equal(users.deskCdpOn("a"), false);
    assert.equal(users.projectUrlOn(ada.id, "a"), ADA);
    assert.deepEqual(apply, [true, false]);
  });

  it("skips members who already have a valid project-only URL", async () => {
    const users = store();
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    users.update(ada.id, { projectDesk: "a", projectUrl: ADA, projectName: "ada" });
    const tried = [];
    const r = await runEnableJob({
      deskId: "a",
      users,
      occupied: false,
      applyCdp: async () => {},
      persistCdp: (on) => users.setDeskCdp("a", on),
      hasSession: async () => true,
      createProject: async (_id, member) => {
        tried.push(member.username);
        return { ok: true, url: ADA, memory: "project-only" };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(users.deskCdpOn("a"), true);
    assert.deepEqual(tried, []);
  });

  it("does not include the admin in the assigned-member job", async () => {
    const users = store();
    const names = [];
    await runEnableJob({
      deskId: "a",
      users,
      occupied: false,
      applyCdp: async () => {},
      persistCdp: (on) => users.setDeskCdp("a", on),
      hasSession: async () => true,
      createProject: async (_id, member) => {
        names.push(member.username);
        return { ok: true, url: ADA, memory: "project-only" };
      },
    });
    assert.equal(names.includes("admin"), false);
  });

  it("retries a null session probe until ChatGPT is known logged in", async () => {
    const users = store();
    let n = 0;
    const r = await runEnableJob({
      deskId: "a",
      users,
      occupied: false,
      applyCdp: async () => {},
      persistCdp: (on) => users.setDeskCdp("a", on),
      hasSession: async () => {
        n += 1;
        if (n < 3) return null;
        return true;
      },
      createProject: async () => ({ ok: true, url: ADA, memory: "project-only" }),
      sessionProbeTimeoutMs: 1000,
      sessionProbeIntervalMs: 1,
    });
    assert.equal(r.ok, true);
    assert.equal(r.cdp, true);
    assert.equal(n, 3);
    assert.equal(users.deskCdpOn("a"), true);
  });

  it("returns SESSION_UNKNOWN after the probe stays unknown past the timeout", async () => {
    const users = store();
    let now = 0;
    let calls = 0;
    const apply = [];
    const r = await runEnableJob({
      deskId: "a",
      users,
      occupied: false,
      applyCdp: async (on) => apply.push(on),
      persistCdp: (on) => users.setDeskCdp("a", on),
      hasSession: async () => {
        calls += 1;
        return null;
      },
      createProject: async () => ({ ok: true, url: ADA, memory: "project-only" }),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      sessionProbeTimeoutMs: 50,
      sessionProbeIntervalMs: 10,
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
    assert.equal(r.error, SESSION_UNKNOWN);
    assert.ok(calls >= 2);
    assert.equal(users.deskCdpOn("a"), false);
    assert.deepEqual(apply, [true, false]);
  });

  it("refuses to enable while exclusive VNC is occupied", async () => {
    const users = store();
    const r = await runEnableJob({
      deskId: "a",
      users,
      occupied: true,
      applyCdp: async () => {
        throw new Error("should not apply");
      },
      persistCdp: () => users.setDeskCdp("a", true),
      hasSession: async () => true,
      createProject: async () => ({ ok: true, url: ADA, memory: "project-only" }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, ENABLE_OCCUPIED);
    assert.equal(users.deskCdpOn("a"), false);
  });
});

describe("assign while split-screen is on", () => {
  it("does not persist the desk when project create fails", async () => {
    const users = store();
    users.setDeskCdp("a", true);
    const ada = users.create({ username: "ada", password: "secret6", desks: [] });
    const r = await assignDesksWithProjects({
      user: ada,
      nextDesks: ["a"],
      users,
      hasSession: async () => true,
      createProject: async () => ({ ok: false, error: PROJECT_ONLY_REQUIRED }),
    });
    assert.equal(r.ok, false);
    assert.deepEqual(users.get(ada.id).desks, []);
    assert.equal(users.projectUrlOn(ada.id, "a"), "");
  });

  it("fails without assigning when ChatGPT is not logged in", async () => {
    const users = store();
    users.setDeskCdp("a", true);
    const ada = users.create({ username: "ada", password: "secret6", desks: ["b"] });
    const r = await assignDesksWithProjects({
      user: ada,
      nextDesks: ["a", "b"],
      users,
      hasSession: async () => false,
      createProject: async () => ({ ok: true, url: ADA, memory: "project-only" }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /该账号尚未登录 ChatGPT/);
    assert.deepEqual(users.get(ada.id).desks, ["b"]);
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
  it("fails without changing the username when a CDP-on project cannot be created", async () => {
    const users = store();
    users.setDeskCdp("a", true);
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    users.update(ada.id, { projectDesk: "a", projectUrl: ADA, projectName: "ada" });
    const r = await renameMemberWithProjects({
      user: users.get(ada.id),
      username: "ada2",
      users,
      hasSession: async () => true,
      createProject: async () => ({ ok: false, error: PROJECT_ONLY_REQUIRED }),
    });
    assert.equal(r.ok, false);
    assert.equal(users.get(ada.id).username, "ada");
    assert.equal(users.projectUrlOn(ada.id, "a"), ADA);
  });

  it("creates a new project URL and does not merge with the old one", async () => {
    const users = store();
    users.setDeskCdp("a", true);
    const ada = users.create({ username: "ada", password: "secret6", desks: ["a"] });
    users.update(ada.id, { projectDesk: "a", projectUrl: ADA, projectName: "ada" });
    const r = await renameMemberWithProjects({
      user: users.get(ada.id),
      username: "ada2",
      users,
      hasSession: async () => true,
      createProject: async () => ({
        ok: true,
        url: "https://chatgpt.com/g/g-p-aaa222-ada2/project",
        memory: "project-only",
      }),
    });
    assert.equal(r.ok, true);
    assert.equal(users.get(ada.id).username, "ada2");
    assert.equal(users.projectUrlOn(ada.id, "a"), "https://chatgpt.com/g/g-p-aaa222-ada2/project");
    assert.notEqual(users.projectUrlOn(ada.id, "a"), ADA);
  });
});
