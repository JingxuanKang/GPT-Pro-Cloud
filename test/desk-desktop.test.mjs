import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PARKED_WINDOW_BOUNDS, PARKED_WINDOW_X, parkTargetWindow } from "../lib/cdp.mjs";
import {
  dismissCrashRestore,
  isMemberProjectUrl,
  isPrimaryChatGPTUrl,
  pickPrimaryChatGPTTarget,
  prepareAdminDesktop,
  raiseTargetWindow,
  shouldParkForAdmin,
} from "../lib/desk-desktop.mjs";

const HOME = { id: "t-home", type: "page", url: "https://chatgpt.com/" };
const ADA = { id: "t-ada", type: "page", url: "https://chatgpt.com/g/g-p-aaa111-ada/project" };
const BOB = { id: "t-bob", type: "page", url: "https://chatgpt.com/g/g-p-bbb222-bob/project" };

describe("admin desktop vs parked seats", () => {
  it("treats chatgpt.com home as primary and member /g/g-p- as parkable", () => {
    assert.equal(isPrimaryChatGPTUrl("https://chatgpt.com/"), true);
    assert.equal(isPrimaryChatGPTUrl("https://chatgpt.com"), true);
    assert.equal(isPrimaryChatGPTUrl(ADA.url), false);
    assert.equal(isMemberProjectUrl(ADA.url), true);
    assert.equal(isMemberProjectUrl(HOME.url), false);
    const primary = pickPrimaryChatGPTTarget([ADA, HOME, BOB], { claimedTargetIds: ["t-ada", "t-bob"] });
    assert.equal(primary.id, "t-home");
    assert.equal(shouldParkForAdmin(ADA, { claimedTargetIds: ["t-ada"], primaryId: "t-home" }), true);
    assert.equal(shouldParkForAdmin(HOME, { claimedTargetIds: ["t-ada"], primaryId: "t-home" }), false);
  });

  it("does not pick a claimed member project as the admin front window", () => {
    const got = pickPrimaryChatGPTTarget([ADA, BOB], { claimedTargetIds: ["t-ada"] });
    assert.equal(got.id, "t-bob");
    assert.equal(pickPrimaryChatGPTTarget([ADA], { claimedTargetIds: ["t-ada"] }), null);
  });

  it("parks by dropping maximized state then moving off-screen", async () => {
    const bounds = [];
    const cdp = {
      async send(method, params) {
        if (method === "Browser.getWindowForTarget") return { windowId: 4 };
        if (method === "Browser.setWindowBounds") {
          bounds.push(params.bounds);
          return {};
        }
        throw new Error(method);
      },
    };
    assert.equal(await parkTargetWindow(cdp, "t-ada"), true);
    assert.equal(bounds[0].windowState, "normal");
    assert.equal(bounds.at(-1).left, PARKED_WINDOW_X);
    assert.equal(bounds.at(-1).left <= -1000, true);
    assert.equal(bounds.at(-1).windowState, "normal");
    assert.deepEqual(PARKED_WINDOW_BOUNDS.left, PARKED_WINDOW_X);
  });

  it("raises the primary window and dismisses Restore pages with Escape", async () => {
    const calls = [];
    const cdp = {
      async send(method, params) {
        calls.push({ method, params });
        if (method === "Browser.getWindowForTarget") return { windowId: 1 };
        return {};
      },
    };
    assert.equal(await raiseTargetWindow(cdp, "t-home"), true);
    assert.equal(calls.some((c) => c.method === "Target.activateTarget" && c.params.targetId === "t-home"), true);
    assert.equal(
      calls.some((c) => c.method === "Browser.setWindowBounds" && (c.params.bounds.windowState === "maximized" || c.params.bounds.windowState === "fullscreen")),
      true,
    );
    await dismissCrashRestore(cdp);
    assert.equal(calls.some((c) => c.method === "Input.dispatchKeyEvent" && c.params.key === "Escape"), true);
  });

  it("prepareAdminDesktop parks member projects and raises home", async () => {
    const parked = [];
    const calls = [];
    const cdp = {
      async send(method, params) {
        calls.push({ method, params });
        if (method === "Browser.getWindowForTarget") return { windowId: 2 };
        return {};
      },
    };
    const out = await prepareAdminDesktop("a", {
      claimedTargetIds: ["t-ada", "t-bob"],
      listTargets: async () => [HOME, ADA, BOB],
      park: async (_desk, id) => {
        parked.push(id);
        return true;
      },
      pool: { get: async () => cdp },
    });
    assert.equal(out.primaryId, "t-home");
    assert.deepEqual(new Set(parked), new Set(["t-ada", "t-bob"]));
    assert.equal(parked.includes("t-home"), false);
    assert.equal(calls.some((c) => c.method === "Target.activateTarget" && c.params.targetId === "t-home"), true);
  });
});
