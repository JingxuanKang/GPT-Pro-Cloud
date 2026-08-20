/** Talk to the desk Chromium over DevTools (port 9222). */
import {
  createCdpConnection,
  evaluateOnTarget,
  rewriteCdpWs,
  waitForDeskPage,
} from "./cdp.mjs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForDesk(id, timeoutMs = 24000, opts = {}) {
  return waitForDeskPage(id, timeoutMs, opts);
}

export async function evaluateInDesk(id, expression, timeoutMs = 28000, opts = {}) {
  if (timeoutMs && typeof timeoutMs === "object") {
    opts = timeoutMs;
    timeoutMs = 28000;
  }
  if (opts.targetId) {
    return evaluateOnTarget(id, opts.targetId, expression, timeoutMs, opts);
  }
  const page = await waitForDesk(id, Math.min(12000, timeoutMs), opts);
  const cdp = createCdpConnection(rewriteCdpWs(page.webSocketDebuggerUrl, id), Math.min(8000, timeoutMs));
  const timer = setTimeout(() => cdp.close(), timeoutMs);
  try {
    await cdp.ready;
    const result = await Promise.race([
      cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("页面操作超时")), timeoutMs)),
    ]);
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || "页面脚本出错");
    }
    return result?.result?.value;
  } finally {
    clearTimeout(timer);
    cdp.close();
  }
}

export async function peekClipboard(id) {
  const r = await fetch(`http://desktop-${id}:18790/`);
  if (!r.ok) throw new Error("无法读取剪贴板");
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "text/plain; charset=utf-8";
  return { ct, buf };
}

export function isShareUrl(text) {
  return /^https:\/\/chatgpt\.com\/share\/[A-Za-z0-9-]+/i.test(String(text || "").trim());
}

/** Best-effort read of the focused tab: page clipboard, then the current selection. */
export const TAB_CLIP_READ = `(() => {
  return (async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const t = await navigator.clipboard.readText();
        if (t) return t;
      }
    } catch (e) {}
    return (document.getSelection && document.getSelection().toString()) || "";
  })();
})()`;

export const SHARE_CLICK = `(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && el.getClientRects && el.getClientRects().length);
  const labelOf = (el) =>
    ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "") + " " + (el.getAttribute("data-testid") || "")).trim();
  const buttons = () => [...document.querySelectorAll("button, a, [role='button']")];
  const findBtn = (re) =>
    buttons().find((el) => visible(el) && re.test(labelOf(el)));
  return (async () => {
    const share =
      findBtn(/share-chat-button/i) ||
      findBtn(/\\b(Share|分享)\\b/i);
    if (!share) return { ok: false, error: "找不到 Share" };
    share.click();
    await sleep(700);
    const copy =
      findBtn(/copy[- ]?link|复制链接|拷贝链接/i) ||
      findBtn(/copied|已复制/i);
    if (copy) {
      copy.click();
      await sleep(350);
    }
    return { ok: true };
  })();
})()`;

export function projectOnboardScript(name, { create = true } = {}) {
  const n = JSON.stringify(String(name || "").trim());
  const allowCreate = create ? "true" : "false";
  return `(() => {
    const want = ${n};
    const allowCreate = ${allowCreate};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (el) => !!(el && el.getClientRects && el.getClientRects().length);
    const labelOf = (el) =>
      ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).replace(/\\s+/g, " ").trim();
    const textOf = (el) => (el.innerText || "").replace(/\\s+/g, " ").trim();
    const findBtn = (re, root = document) =>
      [...root.querySelectorAll("button, a, [role='button'], [role='menuitem'], [role='menuitemradio']")].find(
        (el) => visible(el) && re.test(labelOf(el)),
      );
    const createForm = () =>
      [...document.querySelectorAll("form, [role='dialog'], [role='alertdialog']")].find(
        (el) =>
          visible(el) &&
          /Project name|项目名称|Create project|创建项目/i.test(el.innerText || "") &&
          el.querySelector("input[name='projectName'], input[type='text'], input:not([type]), input[type='search']"),
      );
    const inCreateForm = (el) => {
      const form = el?.closest?.("form");
      return !!(form && /Project name|项目名称/i.test(form.innerText || ""));
    };
    const findProject = () =>
      [...document.querySelectorAll("button, a, [role='button']")].find((el) => {
        if (!visible(el) || inCreateForm(el)) return false;
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (/open project options|open project home|edit the title|new project|create project/i.test(aria)) return false;
        return textOf(el) === want || aria === want;
      });
    const inProject = () => {
      if (createForm()) return false;
      const h1 = [...document.querySelectorAll("h1")].find((el) => visible(el) && textOf(el) === want);
      return document.title === "ChatGPT - " + want || !!h1 || !!findProject();
    };
    const openFound = (item) => {
      const wrap = item.closest("li") || item.parentElement || item;
      const home = [...wrap.querySelectorAll("button, a")].find((el) =>
        /open project home/i.test(el.getAttribute("aria-label") || ""),
      );
      (home || item).click();
    };
    const dismissForm = () => {
      if (!createForm()) return;
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    };
    const setInput = (input, value) => {
      input.focus();
      const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement : window.HTMLInputElement;
      const native = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
      if (native) native.call(input, value);
      else input.value = value;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    return (async () => {
      if (!want) return { ok: false, error: "没有用户名" };
      const readyUntil = Date.now() + 14000;
      while (Date.now() < readyUntil) {
        if (findBtn(/open sidebar/i) && !findBtn(/new project|新建项目/i) && !findProject() && !createForm()) {
          findBtn(/open sidebar/i).click();
          await sleep(350);
        }
        const more = findBtn(/^show more$|^显示更多$/i);
        if (more) {
          more.click();
          await sleep(250);
        }
        if (inProject() || findProject() || createForm() || findBtn(/new project|新建项目/i)) break;
        await sleep(350);
      }
      if (inProject()) {
        dismissForm();
        return { ok: true, action: "opened" };
      }
      const existing = findProject();
      if (existing) {
        dismissForm();
        await sleep(200);
        openFound(existing);
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          if (inProject()) return { ok: true, action: "opened" };
          await sleep(200);
        }
        return { ok: true, action: "opened" };
      }
      if (!allowCreate) return { ok: false, error: "找不到项目" };
      let form = createForm();
      if (!form) {
        const plus = findBtn(/^new project$|^新建项目$/i) || findBtn(/new project|新建项目/i);
        if (!plus) return { ok: false, error: "找不到 New project" };
        plus.click();
        const formUntil = Date.now() + 6000;
        while (Date.now() < formUntil) {
          form = createForm();
          if (form) break;
          await sleep(250);
        }
      }
      if (!form) return { ok: false, error: "没有出现创建框" };
      const input =
        form.querySelector("input[name='projectName'], input[placeholder], input[type='text']") ||
        form.querySelector("input:not([type='file']):not([type='hidden'])");
      if (!input) return { ok: false, error: "找不到项目名" };
      setInput(input, want);
      const enabledUntil = Date.now() + 2500;
      let create = null;
      while (Date.now() < enabledUntil) {
        create = [...form.querySelectorAll("button")].find((el) => {
          if (!visible(el)) return false;
          return /^(Create project|创建项目)$/i.test(textOf(el));
        });
        if (create && !create.disabled) break;
        await sleep(120);
      }
      const mem = findBtn(/default memory|project-only memory|默认记忆|仅项目/i, form);
      if (mem && !/project-only|仅项目/i.test(labelOf(mem))) {
        mem.click();
        await sleep(400);
        const opt =
          findBtn(/project-only memory/i) ||
          [...document.querySelectorAll("[role='menuitemradio'], [role='menuitem'], [role='option']")].find(
            (el) => visible(el) && /project-only memory|仅项目/i.test(labelOf(el)),
          );
        if (!opt) return { ok: false, error: "找不到 Project-only Memory" };
        opt.click();
        await sleep(250);
      }
      create = [...form.querySelectorAll("button")].find((el) => {
        if (!visible(el)) return false;
        return /^(Create project|创建项目)$/i.test(textOf(el));
      });
      if (!create) return { ok: false, error: "找不到创建按钮" };
      if (create.disabled) return { ok: false, error: "创建按钮不可用" };
      create.click();
      const openUntil = Date.now() + 10000;
      while (Date.now() < openUntil) {
        const more = findBtn(/^show more$|^显示更多$/i);
        if (more) more.click();
        if (inProject()) return { ok: true, action: "created" };
        await sleep(300);
      }
      return { ok: false, error: "项目没有出现" };
    })();
  })()`;
}

export { sleep };
