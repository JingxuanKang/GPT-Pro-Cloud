/** Talk to the desk Chromium over DevTools (port 9222). */
import { evaluateOnTarget, waitForDeskPage } from "./cdp.mjs";

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
  if (!page?.id) throw new Error("工作区还没准备好");
  // Browser WS + Target.attachToTarget — do not open the page debugger URL,
  // which would block deskHasChatGPTSession / tab-seat create (phoenix/#10).
  return evaluateOnTarget(id, page.id, expression, timeoutMs, opts);
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

/**
 * Sidebar / in-page project links. Parked tabs often have zero client rects,
 * so this must not require visible() / getClientRects.
 */
export const LIST_PROJECT_LINKS = `(() => {
  const seen = new Set();
  const items = [];
  for (const el of document.querySelectorAll("a[href], [href]")) {
    const raw = el.getAttribute("href") || el.href || "";
    if (!raw || raw === "#" || !/g-p-/i.test(raw)) continue;
    let href = "";
    try { href = new URL(raw, location.href).href; } catch { continue; }
    if (!/\\/g\\/g-p-[^/?#]+/i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim();
    items.push({ href, text });
  }
  return items;
})()`;

export async function listSeatProjectLinks(deskId, targetId) {
  try {
    const raw = await evaluateInDesk(deskId, LIST_PROJECT_LINKS, 8000, { targetId });
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function projectOnboardScript(name, { create = true } = {}) {
  const n = JSON.stringify(String(name || "").trim());
  const allowCreate = create ? "true" : "false";
  return `(() => {
    const want = ${n};
    const allowCreate = ${allowCreate};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const present = (el) => !!(el && el.isConnected !== false);
    const labelOf = (el) =>
      ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).replace(/\\s+/g, " ").trim();
    const textOf = (el) => (el.innerText || "").replace(/\\s+/g, " ").trim();
    const findBtn = (re, root = document) =>
      [...root.querySelectorAll("button, a, [role='button'], [role='menuitem'], [role='menuitemradio']")].find(
        (el) => present(el) && re.test(labelOf(el)),
      );
    const createForm = () =>
      [...document.querySelectorAll("form, [role='dialog'], [role='alertdialog']")].find(
        (el) =>
          present(el) &&
          /Project name|项目名称|Create project|创建项目/i.test(el.innerText || "") &&
          el.querySelector("input[name='projectName'], input[type='text'], input:not([type]), input[type='search']"),
      );
    const inCreateForm = (el) => {
      const form = el?.closest?.("form");
      return !!(form && /Project name|项目名称/i.test(form.innerText || ""));
    };
    const slugOf = (href) => {
      try {
        const m = String(new URL(href, location.href).pathname || "").match(/\\/g\\/g-p-[^/-]+-([^/?#]+)/i);
        return (m && m[1] || "").toLowerCase();
      } catch {
        return "";
      }
    };
    const wantSlug = String(want).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const hrefOf = (item) => {
      if (!item) return "";
      const a = item.closest?.("a[href]") || item;
      const raw = a.href || a.getAttribute?.("href") || "";
      if (!raw) return "";
      try { return new URL(raw, location.href).href.split("?")[0].split("#")[0]; } catch { return raw; }
    };
    const findProject = () =>
      [...document.querySelectorAll("button, a, [role='button'], [href]")].find((el) => {
        if (!present(el) || inCreateForm(el)) return false;
        const aria = (el.getAttribute("aria-label") || "").trim();
        if (/open project options|open project home|edit the title|new project|create project/i.test(aria)) return false;
        if (textOf(el) === want || aria === want) return true;
        const href = el.href || el.getAttribute("href") || "";
        return !!(wantSlug && slugOf(href) === wantSlug);
      });
    const projectHref = () => {
      if (/\\/g\\/g-p-[^/?#]+\\/project(?:[/?#]|$)/i.test(location.href)) {
        return location.href.split("?")[0].split("#")[0];
      }
      if (/\\/g\\/g-p-[^/?#]+/i.test(location.href)) return location.href.split("?")[0].split("#")[0];
      const fromItem = hrefOf(findProject());
      return /\\/g\\/g-p-[^/?#]+/i.test(fromItem) ? fromItem : "";
    };
    const onProjectPage = () => /\\/g\\/g-p-[^/?#]+/i.test(location.href);
    const inProject = () => {
      if (createForm()) return false;
      if (onProjectPage()) return true;
      const h1 = [...document.querySelectorAll("h1")].find((el) => present(el) && textOf(el) === want);
      return document.title === "ChatGPT - " + want || !!h1;
    };
    const looksLoggedOut = () => {
      const href = String(location.href || "");
      if (/auth\\.openai\\.com|\\/auth\\/login|\\/log-?in/i.test(href)) return true;
      return !!(findBtn(/^(log in|sign in|登录)$/i) && !findBtn(/new project|新建项目/i) && !findProject());
    };
    const looksCaptcha = () => {
      if (document.querySelector("iframe[src*='captcha'], iframe[src*='hcaptcha'], [data-hcaptcha], [class*='captcha' i]")) return true;
      return /verification challenge|hcaptcha|请完成验证/i.test(document.body?.innerText || "");
    };
    const memoryLabel = (el) => labelOf(el);
    const memorySelected = (el) =>
      !!(
        el &&
        (el.getAttribute("aria-checked") === "true" ||
          el.getAttribute("aria-pressed") === "true" ||
          el.getAttribute("data-state") === "checked" ||
          /\\b(selected|checked)\\b/i.test(el.className || ""))
      );
    const memoryState = (root = document) => {
      const mem = findBtn(/default memory|project-only memory|默认记忆|仅项目|账号记忆|account memory/i, root);
      if (mem) {
        if (/project-only|仅项目/i.test(memoryLabel(mem))) return "project-only";
        if (/default memory|默认记忆|账号记忆|account memory/i.test(memoryLabel(mem))) return "default";
      }
      const nodes = [...root.querySelectorAll("button, [role='button'], [role='menuitem'], [role='menuitemradio'], [role='radio'], label")];
      const only = nodes.find((el) => present(el) && /project-only memory|仅项目/i.test(memoryLabel(el)));
      const def = nodes.find((el) => present(el) && /default memory|默认记忆|账号记忆|account memory/i.test(memoryLabel(el)));
      if (only && memorySelected(only)) return "project-only";
      if (def && memorySelected(def)) return "default";
      return "";
    };
    const setProjectOnlyOnForm = async (form) => {
      const mem = findBtn(/default memory|project-only memory|默认记忆|仅项目|账号记忆|account memory/i, form);
      if (!mem) return { ok: false, error: "无法将项目设为仅项目记忆" };
      if (/project-only|仅项目/i.test(labelOf(mem)) && memoryState(form) !== "default") {
        return { ok: true, memory: "project-only" };
      }
      mem.click();
      await sleep(400);
      const opt =
        findBtn(/project-only memory/i) ||
        [...document.querySelectorAll("[role='menuitemradio'], [role='menuitem'], [role='option']")].find(
          (el) => present(el) && /project-only memory|仅项目/i.test(labelOf(el)),
        );
      if (!opt) return { ok: false, error: "无法将项目设为仅项目记忆" };
      opt.click();
      await sleep(250);
      if (memoryState(form) === "default") return { ok: false, error: "无法将项目设为仅项目记忆" };
      if (!/project-only|仅项目/i.test(labelOf(findBtn(/default memory|project-only memory|默认记忆|仅项目/i, form) || mem))) {
        return { ok: false, error: "无法将项目设为仅项目记忆" };
      }
      return { ok: true, memory: "project-only" };
    };
    const confirmExistingMemory = async () => {
      let mem = memoryState();
      if (mem === "project-only") return { ok: true, memory: "project-only" };
      if (mem === "default") return { ok: false, error: "已有同名项目使用账号默认记忆，请管理员在完整桌面中改为仅项目记忆" };
      const settings = findBtn(/project settings|项目设置|memory|记忆/i);
      if (settings) {
        settings.click();
        await sleep(450);
        mem = memoryState();
      }
      if (mem === "project-only") return { ok: true, memory: "project-only" };
      if (mem === "default") return { ok: false, error: "已有同名项目使用账号默认记忆，请管理员在完整桌面中改为仅项目记忆" };
      return { ok: false, error: "无法确认项目记忆范围，请管理员在完整桌面中检查" };
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
      if (looksCaptcha()) return { ok: false, error: "遇到验证码，请管理员在完整桌面中完成验证后再试" };
      if (looksLoggedOut()) return { ok: false, error: "该账号尚未登录 ChatGPT" };
      const readyUntil = Date.now() + 14000;
      while (Date.now() < readyUntil) {
        if (looksCaptcha()) return { ok: false, error: "遇到验证码，请管理员在完整桌面中完成验证后再试" };
        if (looksLoggedOut()) return { ok: false, error: "该账号尚未登录 ChatGPT" };
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
        const checked = await confirmExistingMemory();
        if (!checked.ok) return checked;
        return { ok: true, action: "opened", url: projectHref(), memory: "project-only" };
      }
      const existing = findProject();
      if (existing) {
        dismissForm();
        await sleep(200);
        openFound(existing);
        const until = Date.now() + 5000;
        while (Date.now() < until) {
          if (onProjectPage()) break;
          await sleep(200);
        }
        const href = projectHref() || hrefOf(existing);
        if (!href) return { ok: false, error: "未进入项目" };
        const checked = await confirmExistingMemory();
        if (!checked.ok) return checked;
        return { ok: true, action: "opened", url: href, memory: "project-only" };
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
          if (!present(el)) return false;
          return /^(Create project|创建项目)$/i.test(textOf(el));
        });
        if (create && !create.disabled) break;
        await sleep(120);
      }
      const memory = await setProjectOnlyOnForm(form);
      if (!memory.ok) return memory;
      create = [...form.querySelectorAll("button")].find((el) => {
        if (!present(el)) return false;
        return /^(Create project|创建项目)$/i.test(textOf(el));
      });
      if (!create) return { ok: false, error: "找不到创建按钮" };
      if (create.disabled) return { ok: false, error: "创建按钮不可用" };
      create.click();
      const openUntil = Date.now() + 10000;
      while (Date.now() < openUntil) {
        if (looksCaptcha()) return { ok: false, error: "遇到验证码，请管理员在完整桌面中完成验证后再试" };
        const more = findBtn(/^show more$|^显示更多$/i);
        if (more) more.click();
        if (inProject()) return { ok: true, action: "created", url: projectHref(), memory: "project-only" };
        await sleep(300);
      }
      return { ok: false, error: "项目没有出现" };
    })();
  })()`;
}

export const READ_PROJECT_URL = `(() => location.href)()`;

export { sleep };
