import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHATGPT_START } from "../lib/cdp.mjs";
import {
  applyJailCssViaCdp,
  bounceUrl,
  canonicalizeProjectUrl,
  createSeatJailRegistry,
  isAllowedJailUrl,
  JAIL_CSS_ID,
  markJailProbeExpression,
  projectJailHideCss,
  projectJailProbeExpression,
  projectRowForControl,
  shouldApplyProjectHideMark,
  shouldEnforceJailReplace,
  shouldReuseSeatJail,
  isChatGPTProjectPath,
  isDownloadOrAssetUrl,
  isMainFrameNav,
  isOtherProjectUrl,
  isOwnProjectUrl,
  jailNavUrl,
  parseChatGPTProjectUrl,
  projectJailScript,
  pickNamedProjectHref,
  projectUrlFromOnboard,
  seatStartUrl,
  slugifyProjectName,
  shouldBlockProjectClick,
  shouldHideOtherProject,
  armSeatJail,
  isBlockedJailChord,
  isCopyOrPasteChord,
  shouldCloseExtraTarget,
  shouldForwardSeatKey,
  jailHotkeyScript,
} from "../lib/project-jail.mjs";

const ADA = "https://chatgpt.com/g/g-p-aaa111-ada/project";
const ADA_CHAT = "https://chatgpt.com/g/g-p-aaa111-ada/c/conv-1";
const BOB = "https://chatgpt.com/g/g-p-bbb222-bob/project";
const BOB_CHAT = "https://chatgpt.com/g/g-p-bbb222-bob/c/conv-9";

describe("ChatGPT project URL helpers", () => {
  it("parses /g/g-p-<id>-<slug>/project and canonicalizes to the project home", () => {
    const parsed = parseChatGPTProjectUrl(ADA_CHAT);
    assert.equal(parsed.id, "aaa111");
    assert.equal(parsed.slug, "ada");
    assert.equal(parsed.token, "g-p-aaa111-ada");
    assert.equal(parsed.home, ADA);
    assert.equal(canonicalizeProjectUrl(ADA_CHAT), ADA);
    assert.equal(canonicalizeProjectUrl("https://example.com/"), "");
    assert.equal(isChatGPTProjectPath("/g/g-p-aaa111-ada/project"), true);
    assert.equal(isChatGPTProjectPath("/c/conv-1"), false);
  });

  it("treats chats inside the same project as own, and another /g/g-p- as other", () => {
    assert.equal(isOwnProjectUrl(ADA, ADA), true);
    assert.equal(isOwnProjectUrl(ADA_CHAT, ADA), true);
    assert.equal(isOwnProjectUrl(BOB, ADA), false);
    assert.equal(isOtherProjectUrl(BOB, ADA), true);
    assert.equal(isOtherProjectUrl(BOB_CHAT, ADA), true);
    assert.equal(isOtherProjectUrl("https://chatgpt.com/c/plain", ADA), false);
  });
});

describe("jail allowlist and bounce", () => {
  it("allows the member project, chats in that project, login/SSO, and assets", () => {
    const allowed = [
      ADA,
      ADA_CHAT,
      "https://chatgpt.com/g/g-p-aaa111-ada",
      "https://chatgpt.com/auth/login",
      "https://chatgpt.com/sign-in",
      "https://auth.openai.com/log-in",
      "https://accounts.google.com/o/oauth2/auth",
      "https://appleid.apple.com/auth/authorize",
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      "https://cdn.oaistatic.com/assets/app.js",
      "blob:https://chatgpt.com/g/g-p-aaa111-ada/1",
      "data:image/png;base64,aaa",
    ];
    for (const href of allowed) {
      assert.equal(isAllowedJailUrl(href, ADA), true, href);
      assert.equal(bounceUrl(href, ADA), null, href);
    }
    assert.equal(isDownloadOrAssetUrl("https://files.oaiusercontent.com/out.png"), true);
  });

  it("bounces another /g/g-p-… path and leaves own-project chats and chatgpt.com surfaces alone", () => {
    const blocked = [BOB, BOB_CHAT, `${BOB}?utm=1`, `${BOB_CHAT}#x`];
    for (const href of blocked) {
      assert.equal(isAllowedJailUrl(href, ADA), false, href);
      assert.equal(bounceUrl(href, ADA), ADA, href);
    }
    const stay = [
      "https://chatgpt.com/",
      "https://chatgpt.com",
      "https://chatgpt.com/c/someone-else",
      "https://chatgpt.com/gpts",
      "https://chatgpt.com/library",
      "https://chat.openai.com/",
    ];
    for (const href of stay) {
      assert.equal(isAllowedJailUrl(href, ADA), true, href);
      assert.equal(bounceUrl(href, ADA), null, href);
    }
  });

  it("does not replace-loop on /c/ inside the own project; query/hash is not a new destination", () => {
    const stay = [
      ADA,
      ADA_CHAT,
      `${ADA}?model=gpt`,
      `${ADA_CHAT}?foo=1`,
      `${ADA}#panel`,
      "https://chatgpt.com/c/conv-1",
      "https://chatgpt.com/c/conv-1?foo=1",
      "https://www.chatgpt.com/g/g-p-aaa111-ada/c/conv-1",
    ];
    for (const href of stay) {
      assert.equal(shouldEnforceJailReplace(href, ADA), false, href);
      assert.equal(bounceUrl(href, ADA), null, href);
    }
  });

  it("still replaces when the URL is a different /g/g-p-… token", () => {
    assert.equal(shouldEnforceJailReplace(BOB, ADA), true);
    assert.equal(shouldEnforceJailReplace(`${BOB}?x=1`, ADA), true);
    assert.equal(shouldEnforceJailReplace(`${BOB_CHAT}#z`, ADA), true);
    assert.equal(bounceUrl(`${BOB}?x=1`, ADA), ADA);
    assert.equal(shouldEnforceJailReplace("https://chatgpt.com/c/plain", ADA), false);
    assert.equal(shouldEnforceJailReplace("https://chatgpt.com/", ADA), false);
  });

  it("does not jail when there is no member project URL", () => {
    assert.equal(isAllowedJailUrl(BOB, ""), true);
    assert.equal(bounceUrl(BOB, ""), null);
    assert.equal(bounceUrl("https://chatgpt.com/", ""), null);
  });
});

describe("sidebar hide and click block", () => {
  it("hides other projects in the sidebar and leaves conversation titles alone", () => {
    assert.equal(shouldHideOtherProject({ href: BOB, home: ADA, inSidebar: true }), true);
    assert.equal(shouldHideOtherProject({ href: ADA, home: ADA, inSidebar: true }), false);
    assert.equal(shouldHideOtherProject({ href: "/c/other-chat", home: ADA, inSidebar: true }), false);
    assert.equal(shouldHideOtherProject({ href: BOB, home: ADA, inSidebar: false }), false);
  });

  it("does not re-apply a hide mark once the row is already tagged", () => {
    assert.equal(shouldApplyProjectHideMark(null), false);
    assert.equal(shouldApplyProjectHideMark({ getAttribute: () => "1" }), false);
    assert.equal(shouldApplyProjectHideMark({ getAttribute: () => null }), true);
    assert.equal(shouldApplyProjectHideMark({ getAttribute: () => "" }), true);
  });

  it("hides the project row, not only the inner control", () => {
    const row = {
      matches: (sel) => String(sel).includes("li"),
      querySelectorAll: () => [{ href: BOB }],
    };
    const link = { closest: (sel) => (String(sel).includes("li") ? row : null) };
    assert.equal(projectRowForControl(link), row);
    assert.equal(projectRowForControl(null), null);
    const inner = { closest: () => null, parentElement: null };
    assert.equal(projectRowForControl(inner), inner);
    const wrapper = {
      querySelectorAll: () => [{ href: BOB }],
      parentElement: {
        querySelectorAll: () => [{ href: BOB }, { href: ADA }],
        parentElement: null,
      },
    };
    const nested = { closest: () => null, parentElement: wrapper };
    assert.equal(projectRowForControl(nested), wrapper);
  });

  it("hides other projects with a stylesheet that targets hrefs and marked rows", () => {
    const css = projectJailHideCss(ADA);
    assert.match(css, /g-p-aaa111-ada/);
    assert.match(css, /data-gpc-hidden-project/);
    assert.match(css, /:has\(/);
    assert.match(css, /\/g\/g-p-/);
    assert.equal(projectJailHideCss(""), "");
  });

  it("blocks clicks to another /g/g-p- path and allows own project and login", () => {
    assert.equal(shouldBlockProjectClick({ href: BOB, home: ADA }), true);
    assert.equal(shouldBlockProjectClick({ href: BOB_CHAT, home: ADA }), true);
    assert.equal(shouldBlockProjectClick({ href: ADA_CHAT, home: ADA }), false);
    assert.equal(shouldBlockProjectClick({ href: "https://chatgpt.com/auth/login", home: ADA }), false);
    assert.equal(shouldBlockProjectClick({ href: BOB, home: "" }), false);
  });
});

describe("seat start URL and onboard capture", () => {
  it("opens the member project only when CDP is on and a project URL is known", () => {
    assert.equal(seatStartUrl({ cdp: true, projectUrl: ADA_CHAT }), ADA);
    assert.equal(seatStartUrl({ cdp: true, projectUrl: "" }), CHATGPT_START);
    assert.equal(seatStartUrl({ cdp: false, projectUrl: ADA }), CHATGPT_START);
    assert.equal(seatStartUrl({}), CHATGPT_START);
  });

  it("reads a project URL from an onboard result", () => {
    assert.equal(projectUrlFromOnboard({ ok: true, url: ADA_CHAT }), ADA);
    assert.equal(projectUrlFromOnboard({ ok: true, action: "opened" }), "");
  });

  it("picks the named sidebar project even when projectReady was already true", () => {
    assert.equal(slugifyProjectName("Test 1"), "test-1");
    assert.equal(slugifyProjectName("test1"), "test1");
    const links = [
      { href: "https://chatgpt.com/g/g-p-aaa111-test1/project", text: "test1" },
      { href: "https://chatgpt.com/g/g-p-bbb222-test2/project", text: "test2" },
      { href: "https://chatgpt.com/g/g-p-ccc333-admin/project", text: "admin" },
    ];
    assert.equal(pickNamedProjectHref("test1", links), "https://chatgpt.com/g/g-p-aaa111-test1/project");
    assert.equal(pickNamedProjectHref("test2", links), "https://chatgpt.com/g/g-p-bbb222-test2/project");
    assert.equal(pickNamedProjectHref("admin", links), "https://chatgpt.com/g/g-p-ccc333-admin/project");
    assert.equal(pickNamedProjectHref("test", links), "");
    assert.equal(pickNamedProjectHref("test1", []), "");
    assert.equal(
      pickNamedProjectHref("ada", [{ href: ADA_CHAT, text: "Ada Lovelace" }]),
      ADA,
    );
  });
});

describe("injected jail script", () => {
  it("embeds the member home and hide/block hooks, not a global allowlist", () => {
    const src = projectJailScript(ADA);
    assert.match(src, /g-p-aaa111-ada/);
    assert.match(src, /data-gpc-hidden-project/);
    assert.match(src, /location\.replace/);
    assert.match(src, /auth\.openai\.com/);
    assert.doesNotMatch(src, /completely impossible/i);
    assert.equal(projectJailScript(""), "void 0");
    const keys = jailHotkeyScript();
    assert.match(keys, /window\.open/);
    assert.match(keys, /F12/);
    assert.match(keys, /KeyT|letter/);
  });

  it("uses a stylesheet and token compare so hide/replace do not thrash", () => {
    const src = projectJailScript(ADA);
    assert.match(src, /gpc-project-jail-css/);
    assert.match(src, /data-gpc-project-jail/);
    assert.match(src, /isOther\(location\.href\)/);
    assert.match(src, /childList:\s*true/);
    assert.doesNotMatch(src, /attributeFilter/);
    assert.doesNotMatch(src, /setProperty\(\s*["']display["']/);
    assert.doesNotMatch(src, /next !== location\.href/);
    assert.doesNotMatch(src, /\[class\*='project' i\]/);
  });

  it("re-running for the same home still ensures CSS and the probe, not a no-op", () => {
    const src = projectJailScript(ADA);
    assert.match(src, /css:\s*cssReady\(\)/);
    assert.match(src, /adoptedStyleSheets/);
    assert.match(src, /ensureCss/);
    assert.match(src, /already/);
    assert.match(src, /if \(already\) return window\.__gpcProjectJail/);
    assert.doesNotMatch(src, /home === .+\) return;/);
    assert.match(src, new RegExp(JAIL_CSS_ID));
    const probe = projectJailProbeExpression();
    assert.match(probe, /__gpcProjectJail/);
    assert.match(probe, /gpc-project-jail-css/);
    const mark = markJailProbeExpression(ADA, true);
    assert.match(mark, /g-p-aaa111-ada/);
    assert.match(mark, /j\.css = true/);
  });
});

describe("escape hotkeys and extra targets", () => {
  const cmd = (code, extra = {}) => ({ code, key: extra.key, modifiers: 2, ...extra });
  const meta = (code) => ({ code, modifiers: 4 });

  it("blocks new-tab / window / address-bar / devtools chords and keeps C/V", () => {
    const blocked = [
      cmd("KeyT"),
      meta("KeyT"),
      cmd("KeyN"),
      cmd("KeyL"),
      cmd("KeyW"),
      { code: "Tab", key: "Tab", modifiers: 2 },
      { code: "Tab", key: "Tab", modifiers: 2 + 8 },
      { code: "KeyT", modifiers: 2 + 8 },
      { code: "KeyD", modifiers: 1 },
      { code: "F6", key: "F6", modifiers: 0 },
      { code: "F12", key: "F12", modifiers: 0 },
      { code: "KeyI", modifiers: 2 + 8 },
      { code: "KeyJ", modifiers: 2 + 8 },
      { code: "KeyC", modifiers: 2 + 8 },
      cmd("KeyU"),
    ];
    for (const msg of blocked) {
      assert.equal(isBlockedJailChord(msg), true, JSON.stringify(msg));
      assert.equal(shouldForwardSeatKey(msg), false, JSON.stringify(msg));
    }
    assert.equal(isCopyOrPasteChord(cmd("KeyC")), true);
    assert.equal(isCopyOrPasteChord(cmd("KeyV")), true);
    assert.equal(isBlockedJailChord(cmd("KeyC")), false);
    assert.equal(isBlockedJailChord(cmd("KeyV")), false);
    assert.equal(shouldForwardSeatKey(cmd("KeyC")), true);
    assert.equal(isBlockedJailChord({ code: "Tab", key: "Tab", modifiers: 0 }), false);
    assert.equal(isBlockedJailChord({ code: "KeyT", key: "t", modifiers: 0 }), false);
    assert.equal(isBlockedJailChord({ code: "KeyA", modifiers: 2 }), false);
  });

  it("closes a page target opened from this seat and leaves other seats alone", () => {
    const created = {
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "t-popup", type: "page", openerId: "t-ada", url: "https://chatgpt.com/" } },
    };
    assert.equal(shouldCloseExtraTarget(created, "t-ada"), true);
    assert.equal(shouldCloseExtraTarget(created, "t-bob"), false);
    assert.equal(
      shouldCloseExtraTarget(
        { method: "Target.targetCreated", params: { targetInfo: { targetId: "t-bob", type: "page" } } },
        "t-ada",
      ),
      false,
    );
  });
});

describe("CDP Page.navigate lock", () => {
  it("injects the jail and bounces another project navigation back to home", async () => {
    const calls = [];
    const listeners = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && params?.expression === "location.href") {
        return { result: { value: ADA } };
      }
      return {};
    };
    const jail = await armSeatJail({
      send,
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      sessionId: "s1",
      homeUrl: ADA,
      targetId: "t-ada",
    });
    assert.equal(jail.armed, true);
    assert.equal(jail.home, ADA);
    assert.equal(
      calls.some((c) => c.method === "Page.addScriptToEvaluateOnNewDocument" && /g-p-aaa111-ada/.test(c.params.source)),
      true,
    );
    assert.equal(calls.some((c) => c.method === "Page.enable"), true);
    assert.equal(
      calls.some((c) => c.method === "Page.setWindowOpenHandler" && c.params.action === "deny"),
      true,
    );

    const nav = {
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: BOB, parentId: undefined } },
    };
    assert.equal(isMainFrameNav(nav), true);
    assert.equal(jailNavUrl(nav), BOB);
    listeners[0](nav);
    await Promise.resolve();
    assert.equal(
      calls.some((c) => c.method === "Page.navigate" && c.params.url === ADA),
      true,
    );
    listeners[0]({
      method: "Target.targetCreated",
      params: { targetInfo: { targetId: "t-popup", type: "page", openerId: "t-ada" } },
    });
    await Promise.resolve();
    assert.equal(
      calls.some((c) => c.method === "Target.closeTarget" && c.params.targetId === "t-popup"),
      true,
    );
  });

  it("does not bounce login or an own-project chat, and ignores child frames", async () => {
    const calls = [];
    const listeners = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && params?.expression === "location.href") {
        return { result: { value: ADA } };
      }
      return {};
    };
    await armSeatJail({
      send,
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      sessionId: "s1",
      homeUrl: ADA,
    });
    const before = calls.filter((c) => c.method === "Page.navigate").length;
    listeners[0]({
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: ADA_CHAT } },
    });
    listeners[0]({
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: "https://auth.openai.com/log-in", parentId: undefined } },
    });
    listeners[0]({
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: BOB, parentId: "child" } },
    });
    await Promise.resolve();
    assert.equal(calls.filter((c) => c.method === "Page.navigate").length, before);
  });

  it("bounces another /g/g-p-… tab to the project home and re-injects jail globals", async () => {
    const calls = [];
    const listeners = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && params?.expression === "location.href") {
        return { result: { value: BOB } };
      }
      return {};
    };
    const jail = await armSeatJail({
      send,
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      sessionId: "s1",
      homeUrl: ADA,
      targetId: "t-ada",
    });
    assert.equal(jail.armed, true);
    assert.equal(
      calls.some((c) => c.method === "Page.navigate" && c.params.url === ADA),
      true,
    );
    assert.ok(
      calls.some(
        (c) =>
          c.method === "Runtime.evaluate" &&
          typeof c.params?.expression === "string" &&
          c.params.expression.includes("__gpcProjectJail"),
      ),
    );
    const before = calls.filter((c) => c.method === "Runtime.evaluate").length;
    listeners[0]({
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: ADA, parentId: undefined } },
    });
    await Promise.resolve();
    assert.ok(calls.filter((c) => c.method === "Runtime.evaluate").length > before);
  });

  it("does not bounce an in-project /c/ chat or chatgpt.com root via Page.navigate", async () => {
    const calls = [];
    const listeners = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && params?.expression === "location.href") {
        return { result: { value: ADA_CHAT } };
      }
      return {};
    };
    await armSeatJail({
      send,
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      sessionId: "s1",
      homeUrl: ADA,
    });
    const before = calls.filter((c) => c.method === "Page.navigate").length;
    listeners[0]({
      method: "Page.navigatedWithinDocument",
      sessionId: "s1",
      params: { url: ADA_CHAT },
    });
    listeners[0]({
      method: "Page.navigatedWithinDocument",
      sessionId: "s1",
      params: { url: "https://chatgpt.com/c/conv-1" },
    });
    listeners[0]({
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: "https://chatgpt.com/", parentId: undefined } },
    });
    await Promise.resolve();
    assert.equal(calls.filter((c) => c.method === "Page.navigate").length, before);
    listeners[0]({
      method: "Page.frameNavigated",
      sessionId: "s1",
      params: { frame: { url: BOB, parentId: undefined } },
    });
    await Promise.resolve();
    assert.equal(
      calls.some((c) => c.method === "Page.navigate" && c.params.url === ADA),
      true,
    );
  });

  it("applies a CDP stylesheet and re-injects after load so the probe survives a second open", async () => {
    const calls = [];
    const listeners = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f1" } } };
      if (method === "CSS.createStyleSheet") return { styleSheetId: "ss1" };
      if (method === "Runtime.evaluate" && params?.expression === "location.href") {
        return { result: { value: ADA } };
      }
      return {};
    };
    const jail = await armSeatJail({
      send,
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      sessionId: "s1",
      homeUrl: ADA,
      targetId: "t-ada",
    });
    assert.equal(jail.armed, true);
    assert.equal(jail.targetId, "t-ada");
    assert.equal(typeof jail.refresh, "function");
    assert.equal(calls.some((c) => c.method === "CSS.enable"), true);
    assert.equal(calls.some((c) => c.method === "CSS.createStyleSheet" && c.params.frameId === "f1"), true);
    assert.equal(
      calls.some((c) => c.method === "CSS.setStyleSheetText" && c.params.styleSheetId === "ss1" && /g-p-aaa111-ada/.test(c.params.text)),
      true,
    );
    assert.equal(
      calls.some((c) => c.method === "Runtime.evaluate" && /j\.css = true/.test(c.params.expression)),
      true,
    );
    const before = calls.filter((c) => c.method === "Runtime.evaluate").length;
    listeners[0]({ method: "Page.loadEventFired", sessionId: "s1" });
    await Promise.resolve();
    assert.ok(calls.filter((c) => c.method === "Runtime.evaluate").length > before);
    const afterLoad = calls.filter((c) => c.method === "Runtime.evaluate").length;
    await jail.refresh();
    assert.ok(calls.filter((c) => c.method === "Runtime.evaluate").length > afterLoad);
  });

  it("still arms the escape lock without a project URL, and stays off without send", async () => {
    const calls = [];
    const jail = await armSeatJail({
      send: async (method, params) => {
        calls.push({ method, params });
        return {};
      },
      sessionId: "s1",
      targetId: "t-1",
      homeUrl: "",
    });
    assert.equal(jail.armed, true);
    assert.equal(jail.home, "");
    assert.equal(calls.some((c) => c.method === "Page.setWindowOpenHandler"), true);
    assert.equal(calls.some((c) => c.method === "Page.addScriptToEvaluateOnNewDocument"), true);
    const off = await armSeatJail({ homeUrl: ADA });
    assert.equal(off.armed, false);
  });
});

describe("jail CSS via CDP and seat re-arm", () => {
  it("writes hide CSS through CSS.setStyleSheetText when a frame id exists", async () => {
    const calls = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "f9" } } };
      if (method === "CSS.createStyleSheet") return { styleSheetId: "sheet-9" };
      return {};
    };
    const css = projectJailHideCss(ADA);
    const out = await applyJailCssViaCdp(send, "s1", css);
    assert.equal(out.ok, true);
    assert.equal(out.styleSheetId, "sheet-9");
    assert.equal(calls.some((c) => c.method === "CSS.setStyleSheetText" && c.params.styleSheetId === "sheet-9"), true);
    const missing = await applyJailCssViaCdp(async () => ({}), "s1", css);
    assert.equal(missing.ok, false);
  });

  it("reuses a jail only for the same seat target, and refreshes instead of no-op", async () => {
    const seat = { id: "seat-1", deskId: "a", targetId: "t-ada" };
    assert.equal(shouldReuseSeatJail({ home: ADA, targetId: "t-ada", refresh: async () => {} }, seat, ADA), true);
    assert.equal(shouldReuseSeatJail({ home: ADA, targetId: "t-old", refresh: async () => {} }, seat, ADA), false);
    assert.equal(shouldReuseSeatJail({ home: ADA, targetId: "t-ada" }, seat, ADA), false);

    const starts = [];
    const refreshes = [];
    const registry = createSeatJailRegistry();
    const start = async (deskId, targetId, home) => {
      starts.push({ deskId, targetId, home });
      return {
        armed: true,
        home,
        targetId,
        refresh: async () => {
          refreshes.push(targetId);
        },
        dispose() {},
      };
    };
    await registry.arm(seat, ADA, start);
    await registry.arm(seat, ADA, start);
    assert.equal(starts.length, 1);
    assert.deepEqual(refreshes, ["t-ada"]);
    await registry.arm({ ...seat, targetId: "t-ada-2" }, ADA, start);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].targetId, "t-ada-2");
  });
});
