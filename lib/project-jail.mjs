/**
 * Per-seat ChatGPT project UX jail (grok-mini kiosk-guard pattern).
 * Experience lock only — same cookies, not a server ACL.
 * On a jailed member seat, hide the entire left sidebar (project rows are
 * unlabeled DIVs without /g/g-p- hrefs). Bounce other /g/g-p-… paths
 * back to this member's project. Do not block login / SSO.
 * Admin VNC / the primary window is not jailed and stays uncut.
 */
import { attachSeatTarget, CHATGPT_START } from "./cdp.mjs";

export const CHATGPT_ORIGIN = "https://chatgpt.com";
export const PROJECT_PATH_RE = /\/g\/(g-p-[^/?#]+)/i;
export const OTHER_PROJECT_HREF_RE = /\/g\/g-p-[^/?#]+/i;

const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com", "www.chat.openai.com"]);

const AUTH_HOSTS = new Set([
  "auth.openai.com",
  "auth0.openai.com",
  "sso.openai.com",
  "accounts.google.com",
  "appleid.apple.com",
  "idmsa.apple.com",
  "login.microsoftonline.com",
  "login.live.com",
  "github.com",
  "www.github.com",
]);

const AUTH_PATH_RE =
  /^\/(auth|oauth2?|sign-?in|sign-?up|log-?in|log-?out|account|accounts|session|register|callback|device)(\/|$)/i;

const ASSET_EXT_RE = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|css|js|map|mp4|webm)(\?|$)/i;
const ASSET_HOST_RE = /(oaidalleapiprod|oaistatic|oaiusercontent|googleusercontent)/i;

export function parseUrl(href, base = CHATGPT_ORIGIN) {
  try {
    return new URL(String(href || ""), base);
  } catch {
    return null;
  }
}

export function hostOf(url) {
  return String(url?.hostname || "").toLowerCase();
}

export function pathOf(url) {
  const path = String(url?.pathname || "/").replace(/\/+$/, "");
  return path || "/";
}

export function parseChatGPTProjectUrl(href, base = CHATGPT_ORIGIN) {
  const url = parseUrl(href, base);
  if (!url) return null;
  const match = String(url.pathname || "").match(PROJECT_PATH_RE);
  if (!match) return null;
  const token = match[1];
  const rest = token.slice("g-p-".length);
  const dash = rest.indexOf("-");
  const id = dash === -1 ? rest : rest.slice(0, dash);
  const slug = dash === -1 ? "" : rest.slice(dash + 1);
  const prefix = `/g/${token}`;
  const home = `${CHATGPT_ORIGIN}${prefix}/project`;
  return { token, id, slug, prefix, home, url: url.href };
}

export function canonicalizeProjectUrl(href) {
  return parseChatGPTProjectUrl(href)?.home || "";
}

export function isChatGPTHost(host) {
  return CHATGPT_HOSTS.has(String(host || "").toLowerCase());
}

export function isChatGPTProjectPath(path) {
  return PROJECT_PATH_RE.test(String(path || ""));
}

export function isOwnProjectUrl(href, home, base = CHATGPT_ORIGIN) {
  const want = parseChatGPTProjectUrl(home, base);
  const got = parseChatGPTProjectUrl(href, base);
  return !!(want && got && want.token.toLowerCase() === got.token.toLowerCase());
}

/** Adopt a parked member window. Never match the primary chatgpt.com homepage. */
export function pickTargetForProject(targets, { projectUrl, claimedTargetIds = [] } = {}) {
  if (!projectUrl) return null;
  const claimed = new Set((claimedTargetIds || []).filter(Boolean));
  for (const t of targets || []) {
    const id = t?.id || t?.targetId;
    if (!id || claimed.has(id)) continue;
    const type = t.type || "page";
    if (type !== "page") continue;
    if (isOwnProjectUrl(t.url || "", projectUrl)) return { ...t, id };
  }
  return null;
}

export function isOtherProjectUrl(href, home, base = CHATGPT_ORIGIN) {
  const got = parseChatGPTProjectUrl(href, base);
  if (!got) return false;
  return !isOwnProjectUrl(href, home, base);
}

export function isAuthPath(path) {
  return AUTH_PATH_RE.test(String(path || ""));
}

export function isDownloadOrAssetUrl(href) {
  const raw = String(href || "");
  if (/^(blob|data|filesystem|chrome|chrome-extension):/i.test(raw)) return true;
  const url = parseUrl(raw);
  if (!url) return false;
  if (/^(blob|data|filesystem):/i.test(url.protocol)) return true;
  if (ASSET_EXT_RE.test(url.pathname)) return true;
  return ASSET_HOST_RE.test(hostOf(url));
}

export function isAllowedJailUrl(href, home, base = CHATGPT_ORIGIN) {
  if (!home) return true;
  if (isDownloadOrAssetUrl(href)) return true;
  const url = parseUrl(href, base);
  if (!url) return false;
  if (!/^https?:$/i.test(url.protocol)) return isDownloadOrAssetUrl(href);

  const host = hostOf(url);
  if (AUTH_HOSTS.has(host)) return true;
  if (isChatGPTHost(host)) {
    if (isAuthPath(pathOf(url))) return true;
    // Stay on chatgpt.com except another member's /g/g-p-… project.
    // /c/ chats, /, Library, Images are not other projects — bouncing them
    // fights ChatGPT's router and reloads the sidebar every interval tick.
    return !isOtherProjectUrl(href, home, base);
  }
  return false;
}

/** Replace only when the URL is a different /g/g-p-… project (token compare). */
export function shouldEnforceJailReplace(href, home, base = CHATGPT_ORIGIN) {
  return Boolean(home && isOtherProjectUrl(href, home, base));
}

/** null = stay; otherwise navigate to the member's project home. */
export function bounceUrl(href, home, base = CHATGPT_ORIGIN) {
  if (!shouldEnforceJailReplace(href, home, base)) return null;
  return canonicalizeProjectUrl(home) || home;
}

export function shouldHideOtherProject({ href = "", home = "", inSidebar = false } = {}) {
  return Boolean(inSidebar && home && isOtherProjectUrl(href, home));
}

/** Skip restyle when the row is already tagged — React mutations must not thrash. */
export function shouldApplyProjectHideMark(el) {
  return Boolean(el && el.getAttribute?.("data-gpc-hidden-project") !== "1");
}

export const JAIL_SIDEBAR_ATTR = "data-gpc-hidden-sidebar";

export const SIDEBAR_TOGGLE_SELECTOR = [
  '[aria-label="Close sidebar"]',
  '[aria-label="Open sidebar"]',
  '[aria-label="Collapse sidebar"]',
  '[aria-label="关闭侧边栏"]',
  '[aria-label="打开侧边栏"]',
].join(",");

export function shouldApplySidebarHideMark(el) {
  return Boolean(el && el.getAttribute?.("data-gpc-hidden-sidebar") !== "1");
}

/** Prefer the nav/aside column; hide its wrapper when that wrapper is sidebar-only. */
export function sidebarColumnForControl(el) {
  if (!el) return null;
  const landmark = el.closest?.("nav, aside, [role='navigation'], [role='complementary']");
  const node = landmark || el;
  const parent = node.parentElement;
  if (parent && parent.children?.length === 1 && parent.children[0] === node) {
    const doc = node.ownerDocument;
    if (!doc || (parent !== doc.body && parent !== doc.documentElement)) return parent;
  }
  return node;
}

/**
 * Find the left ChatGPT nav (wordmark / New chat / Projects / Chats).
 * Do not match the project main column ("New chat in <name>").
 */
export function findChatSidebarRoot(root) {
  const scope = root && typeof root.querySelector === "function" ? root : null;
  if (!scope) return null;
  const toggle = scope.querySelector(SIDEBAR_TOGGLE_SELECTOR);
  if (toggle) return sidebarColumnForControl(toggle);
  const nodes = scope.querySelectorAll("nav, aside, [role='navigation'], [role='complementary']");
  for (const node of nodes) {
    const text = String(node.textContent || "");
    if (/new chat|新聊天|新对话/i.test(text) && /projects|项目/i.test(text)) {
      return sidebarColumnForControl(node);
    }
  }
  return null;
}

/**
 * Hide the project ROW, not only the inner control. Semantic list rows win;
 * otherwise walk up while the ancestor still wraps a single /g/g-p- link.
 */
export function projectRowForControl(el) {
  if (!el) return null;
  const semantic = el.closest?.("li, [role='listitem'], [role='menuitem'], [role='option'], [role='treeitem'], [role='row']");
  if (semantic) return semantic;
  let node = el.parentElement ?? null;
  let fallback = el;
  for (let i = 0; i < 5 && node; i += 1) {
    const count = node.querySelectorAll?.("[href*='/g/g-p-'], [data-href*='/g/g-p-']")?.length ?? 0;
    if (count > 1) break;
    fallback = node;
    node = node.parentElement ?? null;
  }
  return fallback;
}

/** Stylesheet hide so React inline styles cannot un-hide other projects. */
export const JAIL_CSS_ID = "gpc-project-jail-css";

export function projectJailHideCss(home) {
  const token = parseChatGPTProjectUrl(home)?.token;
  if (!token) return "";
  const own = `/g/${token}`;
  const other = `[href*="/g/g-p-"]:not([href*="${own}"]),[data-href*="/g/g-p-"]:not([data-href*="${own}"])`;
  const box =
    "display:none!important;visibility:hidden!important;pointer-events:none!important;width:0!important;min-width:0!important;max-width:0!important;height:0!important;max-height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;border:none!important";
  return [
    `[data-gpc-hidden-sidebar="1"],[data-gpc-hidden-sidebar="1"] *{${box}}`,
    `#stage-slideover-sidebar,[data-testid="left-sidebar"],[data-testid="screen-sidebar"],nav[aria-label="Chat history"],nav[aria-label="ChatGPT sidebar"],aside[aria-label*="sidebar" i]{${box}}`,
    `[data-gpc-hidden-project="1"],[data-gpc-hidden-project="1"] *{${box}}`,
    `${other}{display:none!important;visibility:hidden!important;pointer-events:none!important}`,
    `li:has(${other}),[role="listitem"]:has(${other}),[role="menuitem"]:has(${other}),[role="option"]:has(${other}),[role="treeitem"]:has(${other}),[role="row"]:has(${other}){${box}}`,
  ].join("");
}

/** Page-world probe phoenix / CDP eval can read after onboard. */
export function projectJailProbeExpression() {
  return `(() => {
    const j = window.__gpcProjectJail || {};
    const node = document.getElementById(${JSON.stringify(JAIL_CSS_ID)});
    return {
      home: j.home || "",
      css: !!(j.css || node),
      href: location.href,
    };
  })()`;
}

export function markJailProbeExpression(home, css = true) {
  const locked = canonicalizeProjectUrl(home) || home;
  return `(() => {
    const j = window.__gpcProjectJail || {};
    j.home = ${JSON.stringify(locked)};
    j.css = ${css ? "true" : `!!(j.css || document.getElementById(${JSON.stringify(JAIL_CSS_ID)}))`};
    window.__gpcProjectJail = j;
    return j;
  })()`;
}

/** Same seat + same target can refresh; a new tab target must re-arm. */
export function shouldReuseSeatJail(existing, seat, home) {
  const locked = canonicalizeProjectUrl(home);
  return Boolean(
    existing &&
      locked &&
      existing.home === locked &&
      existing.targetId &&
      existing.targetId === seat?.targetId &&
      typeof existing.refresh === "function",
  );
}

/** Browser-level stylesheet — survives page CSP that strips <style> tags. */
export async function applyJailCssViaCdp(send, sessionId, css, priorId = "") {
  if (!css || typeof send !== "function") return { ok: false, styleSheetId: "" };
  let styleSheetId = priorId || "";
  const apply = async () => {
    await send("CSS.enable", {}, sessionId);
    if (!styleSheetId) {
      const tree = await send("Page.getFrameTree", {}, sessionId);
      const frameId = tree?.frameTree?.frame?.id || tree?.frame?.id || "";
      if (!frameId) return "";
      const created = await send("CSS.createStyleSheet", { frameId }, sessionId);
      styleSheetId = created?.styleSheetId || "";
    }
    if (!styleSheetId) return "";
    await send("CSS.setStyleSheetText", { styleSheetId, text: css }, sessionId);
    return styleSheetId;
  };
  try {
    const id = await apply();
    return { ok: !!id, styleSheetId: id || "" };
  } catch {
    styleSheetId = "";
    try {
      const id = await apply();
      return { ok: !!id, styleSheetId: id || "" };
    } catch {
      return { ok: false, styleSheetId: "" };
    }
  }
}

export function shouldBlockProjectClick({ href = "", home = "" } = {}) {
  return Boolean(home && isOtherProjectUrl(href, home));
}

export function seatStartUrl({ cdp = false, projectUrl = "" } = {}) {
  if (cdp) {
    const home = canonicalizeProjectUrl(projectUrl);
    if (home) return home;
  }
  return CHATGPT_START;
}

export function projectUrlFromOnboard(result) {
  return canonicalizeProjectUrl(result?.url || result?.href || "");
}

/** ChatGPT project slugs: trim, lower, non-alnum → `-`, strip edge dashes. */
export function slugifyProjectName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pick the named project's canonical home from sidebar (or any) link entries.
 * Matches exact slug or exact visible text — `test` does not match `test1`.
 */
export function pickNamedProjectHref(name, entries) {
  const want = String(name || "").trim().toLowerCase();
  const slug = slugifyProjectName(name);
  if (!want || !Array.isArray(entries)) return "";
  for (const entry of entries) {
    const href = String(entry?.href || entry?.url || "");
    const parsed = parseChatGPTProjectUrl(href);
    if (!parsed) continue;
    const text = String(entry?.text || "").trim().toLowerCase();
    if ((slug && parsed.slug.toLowerCase() === slug) || text === want) return parsed.home;
  }
  return "";
}

/** Attach and Page.navigate a seat to a canonical project home. */
export async function navigateSeatToUrl(deskId, targetId, url, opts = {}) {
  const home = canonicalizeProjectUrl(url);
  if (!deskId || !targetId || !home) return { ok: false, url: "" };
  const attached = await attachSeatTarget(deskId, targetId, opts);
  try {
    await attached.cdp.send("Page.enable", {}, attached.sessionId);
    await attached.cdp.send("Page.navigate", { url: home }, attached.sessionId);
    return { ok: true, url: home };
  } finally {
    await attached.release?.();
  }
}

/** CDP Input modifier bits (same as the tab-seat canvas). */
export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

export function chordModifiers(msg = {}) {
  if (msg.modifiers != null && msg.modifiers !== "") return Number(msg.modifiers) || 0;
  return (msg.alt ? MOD_ALT : 0) + (msg.ctrl ? MOD_CTRL : 0) + (msg.meta ? MOD_META : 0) + (msg.shift ? MOD_SHIFT : 0);
}

function chordLetter(msg = {}) {
  const code = String(msg.code || "");
  if (/^Key[A-Z]$/i.test(code)) return code.slice(3).toUpperCase();
  const key = String(msg.key || "");
  if (/^[a-z]$/i.test(key)) return key.toUpperCase();
  return "";
}

export function isCopyOrPasteChord(msg = {}) {
  const mods = chordModifiers(msg);
  const cmd = !!(mods & (MOD_CTRL | MOD_META));
  if (!cmd || mods & MOD_ALT || mods & MOD_SHIFT) return false;
  const letter = chordLetter(msg);
  return letter === "C" || letter === "V";
}

/**
 * Escape chords the occupant must not send into Chrome.
 * Keep C/V and do not block typing or Tab-without-modifier (composer).
 */
export function isBlockedJailChord(msg = {}) {
  if (isCopyOrPasteChord(msg)) return false;
  const mods = chordModifiers(msg);
  const cmd = !!(mods & (MOD_CTRL | MOD_META));
  const alt = !!(mods & MOD_ALT);
  const shift = !!(mods & MOD_SHIFT);
  const code = String(msg.code || "");
  const key = String(msg.key || "");
  const letter = chordLetter(msg);

  if (code === "F6" || key === "F6" || code === "F12" || key === "F12") return true;
  if (alt && !cmd && letter === "D") return true;
  if (!cmd) return false;
  if (code === "Tab" || key === "Tab") return true;
  if (shift && (letter === "T" || letter === "I" || letter === "J" || letter === "C")) return true;
  if (!alt && (letter === "T" || letter === "N" || letter === "L" || letter === "W" || letter === "U")) return true;
  return false;
}

export function shouldForwardSeatKey(msg) {
  return !isBlockedJailChord(msg);
}

function extraTargetId(msg, seatTargetId) {
  const info = msg?.params?.targetInfo || msg?.params || {};
  const id = String(info.targetId || info.id || "");
  if (!id || !seatTargetId || id === seatTargetId) return "";
  const opener = String(info.openerId || info.openerTargetId || "");
  if (opener && opener === seatTargetId) return id;
  if (msg?.method === "Page.windowOpen") return "";
  return "";
}

export function shouldCloseExtraTarget(msg, seatTargetId) {
  if (!msg || !seatTargetId) return false;
  if (msg.method !== "Target.targetCreated" && msg.method !== "Target.attachedToTarget") return false;
  const info = msg.params?.targetInfo || {};
  const type = String(info.type || "page");
  if (type && type !== "page") return false;
  return !!extraTargetId(msg, seatTargetId);
}

/** In-page hotkey + window.open lock. Safe without a project URL (onboard). */
export function jailHotkeyScript() {
  return `(() => {
    if (window.__gpcJailKeys) return;
    window.__gpcJailKeys = 1;
    const letter = (e) => {
      const code = String(e.code || "");
      if (/^Key[A-Z]$/i.test(code)) return code.slice(3).toUpperCase();
      const key = String(e.key || "");
      return /^[a-z]$/i.test(key) ? key.toUpperCase() : "";
    };
    const blocked = (e) => {
      const cmd = !!(e.ctrlKey || e.metaKey);
      const L = letter(e);
      if (cmd && !e.altKey && !e.shiftKey && (L === "C" || L === "V")) return false;
      if (e.key === "F6" || e.code === "F6" || e.key === "F12" || e.code === "F12") return true;
      if (e.altKey && !cmd && L === "D") return true;
      if (!cmd) return false;
      if (e.key === "Tab" || e.code === "Tab") return true;
      if (e.shiftKey && (L === "T" || L === "I" || L === "J" || L === "C")) return true;
      return !e.altKey && (L === "T" || L === "N" || L === "L" || L === "W" || L === "U");
    };
    document.addEventListener("keydown", (e) => {
      if (!blocked(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, true);
    try { window.open = function () { return null; }; } catch (err) {}
  })()`;
}

/** In-page script: CSS hide + click block + location bounce. Parameterized per seat. */
export function projectJailScript(home) {
  const locked = canonicalizeProjectUrl(home);
  if (!locked) return "void 0";
  return `(() => {
    const HOME = ${JSON.stringify(locked)};
    const CSS_ID = ${JSON.stringify(JAIL_CSS_ID)};
    const already = !!(window.__gpcProjectJail && window.__gpcProjectJail.home === HOME && window.__gpcProjectJail.armed);
    const PROJECT_RE = /\\/g\\/(g-p-[^/?#]+)/i;
    const AUTH_HOSTS = new Set(${JSON.stringify([...AUTH_HOSTS])});
    const CHATGPT_HOSTS = new Set(${JSON.stringify([...CHATGPT_HOSTS])});
    const AUTH_PATH_RE = ${AUTH_PATH_RE};
    const ASSET_EXT_RE = ${ASSET_EXT_RE};
    const CONTROL = 'a, button, [role="link"], [role="button"], [role="menuitem"], [role="tab"]';
    const PROJECT_HREF = "[href*='/g/g-p-'], [data-href*='/g/g-p-']";
    const SIDEBAR_TOGGLE_SELECTOR = ${JSON.stringify(SIDEBAR_TOGGLE_SELECTOR)};
    const HIDE_CSS = ${JSON.stringify(projectJailHideCss(locked))};
    const shouldMark = ${shouldApplyProjectHideMark.toString()};
    const projectRow = ${projectRowForControl.toString()};
    const shouldApplySidebarHideMark = ${shouldApplySidebarHideMark.toString()};
    const sidebarColumnForControl = ${sidebarColumnForControl.toString()};
    const findChatSidebarRoot = ${findChatSidebarRoot.toString()};

    const parse = (href, base) => { try { return new URL(String(href || ""), base || location.href); } catch { return null; } };
    const tokenOf = (href) => {
      const url = parse(href);
      const m = String(url?.pathname || "").match(PROJECT_RE);
      return m ? m[1].toLowerCase() : "";
    };
    const homeToken = tokenOf(HOME);
    const isOther = (href) => {
      const t = tokenOf(href);
      return !!(t && homeToken && t !== homeToken);
    };
    const isAsset = (href) => {
      const raw = String(href || "");
      if (/^(blob|data|filesystem|chrome|chrome-extension):/i.test(raw)) return true;
      const url = parse(raw);
      if (!url) return false;
      if (/^(blob|data|filesystem):/i.test(url.protocol)) return true;
      return ASSET_EXT_RE.test(url.pathname);
    };
    const isAllowed = (href) => {
      if (isAsset(href)) return true;
      const url = parse(href);
      if (!url || !/^https?:$/i.test(url.protocol)) return isAsset(href);
      const host = String(url.hostname || "").toLowerCase();
      if (AUTH_HOSTS.has(host)) return true;
      if (CHATGPT_HOSTS.has(host)) {
        const path = (url.pathname || "/").replace(/\\/+$/, "") || "/";
        if (AUTH_PATH_RE.test(path)) return true;
        return !isOther(href);
      }
      return false;
    };
    const enforce = () => {
      if (!isOther(location.href)) return;
      location.replace(HOME);
    };
    const hrefOf = (el) => {
      if (!el) return "";
      const raw = el.href || el.getAttribute?.("href") || el.getAttribute?.("data-href") || "";
      if (raw && PROJECT_RE.test(String(raw))) return raw;
      const host = el.closest?.(PROJECT_HREF);
      return host ? (host.href || host.getAttribute("href") || host.getAttribute("data-href") || "") : raw;
    };
    const hide = (el) => {
      const row = projectRow(el);
      if (!shouldMark(row)) return;
      row.setAttribute("data-gpc-hidden-project", "1");
      row.setAttribute("aria-hidden", "true");
      row.setAttribute("tabindex", "-1");
    };
    const cssReady = () => {
      try {
        if (document.getElementById(CSS_ID)) return true;
        if (window.__gpcJailSheet && document.adoptedStyleSheets) {
          return Array.from(document.adoptedStyleSheets).indexOf(window.__gpcJailSheet) !== -1;
        }
      } catch (err) {}
      return false;
    };
    const markProbe = (armed) => {
      window.__gpcProjectJail = { home: HOME, css: cssReady(), armed: !!(armed || window.__gpcProjectJail?.armed) };
      return window.__gpcProjectJail;
    };
    const ensureCss = () => {
      try {
        let el = document.getElementById(CSS_ID);
        if (!el) {
          el = document.createElement("style");
          el.id = CSS_ID;
          el.setAttribute("data-gpc-project-jail", "1");
          el.textContent = HIDE_CSS;
          const root = document.head || document.documentElement;
          if (root) root.appendChild(el);
        } else if (!el.textContent) {
          el.textContent = HIDE_CSS;
        }
      } catch (err) {}
      try {
        if (typeof CSSStyleSheet === "function") {
          if (!window.__gpcJailSheet) {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(HIDE_CSS);
            window.__gpcJailSheet = sheet;
          }
          const cur = document.adoptedStyleSheets ? Array.from(document.adoptedStyleSheets) : [];
          if (window.__gpcJailSheet && cur.indexOf(window.__gpcJailSheet) === -1) {
            document.adoptedStyleSheets = cur.concat([window.__gpcJailSheet]);
          }
        }
      } catch (err) {}
      return markProbe(already);
    };
    const hideSidebar = () => {
      ensureCss();
      try {
        const closeBtn = document.querySelector('[aria-label="Close sidebar"],[aria-label="关闭侧边栏"],[aria-label="Collapse sidebar"]');
        if (closeBtn) closeBtn.click();
      } catch (err) {}
      const root = findChatSidebarRoot(document);
      if (!shouldApplySidebarHideMark(root)) return;
      root.setAttribute("data-gpc-hidden-sidebar", "1");
      root.setAttribute("aria-hidden", "true");
    };
    const hideOther = (root) => {
      ensureCss();
      hideSidebar();
      const scope = root && root.querySelectorAll ? root : document;
      const nodes = scope.querySelectorAll(CONTROL + ", " + PROJECT_HREF);
      for (const el of nodes) {
        if (isOther(hrefOf(el))) hide(el);
      }
      if (root && root.matches && root.matches(CONTROL + ", " + PROJECT_HREF) && isOther(hrefOf(root))) hide(root);
    };
    const blockEvent = (event) => {
      const control = event.target?.closest?.(CONTROL + ", " + PROJECT_HREF);
      if (!control || !isOther(hrefOf(control))) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      enforce();
    };

    try { window.open = function () { return null; }; } catch (err) {}
    try { hideOther(document); } catch (err) { markProbe(already); }
    enforce();
    if (already) return window.__gpcProjectJail;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) hideOther(node);
        }
      }
    });
    const start = () => {
      ensureCss();
      observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
      });
      hideOther(document);
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
    document.addEventListener("click", blockEvent, true);
    document.addEventListener("auxclick", blockEvent, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      blockEvent(event);
    }, true);
    window.addEventListener("popstate", enforce);
    window.addEventListener("hashchange", enforce);
    if (globalThis.navigation?.addEventListener) {
      globalThis.navigation.addEventListener("navigate", (event) => {
        const dest = event.destination?.url;
        if (!dest || !isOther(dest)) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        location.replace(HOME);
      });
    }
    setInterval(() => {
      ensureCss();
      hideOther(document);
      enforce();
    }, 800);
    markProbe(true);
    return window.__gpcProjectJail;
  })()`;
}

export function jailNavUrl(msg) {
  if (!msg || typeof msg !== "object") return "";
  const params = msg.params || {};
  return String(params.frame?.url || params.url || "");
}

export function isMainFrameNav(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.method === "Page.navigatedWithinDocument") return true;
  if (msg.method !== "Page.frameNavigated") return false;
  const frame = msg.params?.frame;
  return !!(frame && !frame.parentId);
}

/**
 * Attach Page listeners on an existing CDP session.
 * Escape lock (hotkeys + deny window.open) always; project bounce when home is known.
 */
export async function armSeatJail({ send, on, sessionId, homeUrl, targetId } = {}) {
  if (typeof send !== "function") return { armed: false, home: "", dispose() {} };
  const home = canonicalizeProjectUrl(homeUrl);
  const keys = jailHotkeyScript();
  const script = home ? projectJailScript(home) : keys;

  await send("Page.enable", {}, sessionId);
  try {
    await send("Page.setWindowOpenHandler", { action: "deny" }, sessionId);
  } catch {
    /* older Chromium */
  }
  try {
    await send("Target.setDiscoverTargets", { discover: true });
  } catch {
    /* page sessions may reject browser methods */
  }
  await send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sessionId);
  if (home && script !== keys) {
    try {
      await send("Page.addScriptToEvaluateOnNewDocument", { source: keys }, sessionId);
    } catch {
      /* already included */
    }
  }
  let styleSheetId = "";
  const injectNow = async () => {
    try {
      if (home) {
        await send("Runtime.evaluate", { expression: projectJailScript(home), returnByValue: true }, sessionId);
        const viaCdp = await applyJailCssViaCdp(send, sessionId, projectJailHideCss(home), styleSheetId);
        styleSheetId = viaCdp.styleSheetId || "";
        await send(
          "Runtime.evaluate",
          { expression: markJailProbeExpression(home, viaCdp.ok), returnByValue: true },
          sessionId,
        );
      }
      await send("Runtime.evaluate", { expression: keys, returnByValue: true }, sessionId);
    } catch {
      /* current document may not be ready */
    }
  };
  await injectNow();
  if (home) {
    try {
      const loc = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
      const href = loc?.result?.value || loc;
      const bounce = bounceUrl(typeof href === "string" ? href : "", home);
      if (bounce) await send("Page.navigate", { url: bounce }, sessionId);
    } catch {
      /* navigate is best-effort */
    }
  }

  const dispose =
    typeof on === "function"
      ? on((msg) => {
          if (shouldCloseExtraTarget(msg, targetId)) {
            const extra = extraTargetId(msg, targetId);
            if (extra) send("Target.closeTarget", { targetId: extra }).catch(() => {});
            if (home) send("Page.navigate", { url: home }, sessionId).catch(() => {});
            return;
          }
          if (msg.method === "Page.windowOpen" && (!msg.sessionId || !sessionId || msg.sessionId === sessionId)) {
            if (home) send("Page.navigate", { url: home }, sessionId).catch(() => {});
            return;
          }
          if (!home) return;
          if (sessionId && msg.sessionId && msg.sessionId !== sessionId) return;
          if (msg.method === "Page.loadEventFired" || msg.method === "Page.domContentEventFired") {
            injectNow();
            return;
          }
          if (!isMainFrameNav(msg)) return;
          const href = jailNavUrl(msg);
          const next = bounceUrl(href, home);
          if (next) {
            send("Page.navigate", { url: next }, sessionId).catch(() => {});
            return;
          }
          if (isAllowedJailUrl(href, home)) injectNow();
        })
      : () => {};

  return {
    armed: true,
    home,
    targetId: targetId || "",
    refresh: injectNow,
    dispose: typeof dispose === "function" ? dispose : () => {},
  };
}

export async function startSeatProjectJail(deskId, targetId, homeUrl, opts = {}) {
  const home = canonicalizeProjectUrl(homeUrl);
  if (!deskId || !targetId || !home) return { armed: false, home: "", dispose() {} };
  const attached = await attachSeatTarget(deskId, targetId, opts);
  const armed = await armSeatJail({
    send: (method, params, sid) => attached.cdp.send(method, params, sid),
    on: (fn) => attached.cdp.on(fn),
    sessionId: attached.sessionId,
    homeUrl: home,
    targetId,
  });
  return {
    ...armed,
    dispose() {
      armed.dispose?.();
      attached.release?.();
    },
  };
}

export function createSeatJailRegistry() {
  const jails = new Map();

  const stop = (seatId) => {
    const handle = jails.get(seatId);
    jails.delete(seatId);
    try {
      handle?.dispose?.();
    } catch {
      /* ignore */
    }
    return handle;
  };

  return {
    async arm(seat, homeUrl, start = startSeatProjectJail) {
      if (!seat?.id || !seat.targetId) return { armed: false };
      const home = canonicalizeProjectUrl(homeUrl);
      if (!home) return { armed: false };
      const existing = jails.get(seat.id);
      if (shouldReuseSeatJail(existing, seat, home)) {
        try {
          await existing.refresh();
        } catch {
          /* page may be mid-navigation */
        }
        return existing;
      }
      stop(seat.id);
      const handle = await start(seat.deskId, seat.targetId, home);
      if (handle?.armed) jails.set(seat.id, handle);
      return handle;
    },
    stop,
    get(seatId) {
      return jails.get(seatId);
    },
  };
}
