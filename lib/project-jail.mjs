/**
 * Per-seat ChatGPT project UX jail (grok-mini kiosk-guard pattern).
 * Experience lock only — same cookies, not a server ACL.
 * Hide other *projects* in the sidebar; bounce other /g/g-p-… paths
 * back to this member's project. Do not block login / SSO.
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
  const path = pathOf(url);
  if (AUTH_HOSTS.has(host)) return true;
  if (isChatGPTHost(host) && isAuthPath(path)) return true;
  if (isOwnProjectUrl(href, home, base)) return true;
  return false;
}

/** null = stay; otherwise navigate to the member's project home. */
export function bounceUrl(href, home, base = CHATGPT_ORIGIN) {
  if (!home) return null;
  return isAllowedJailUrl(href, home, base) ? null : home;
}

export function shouldHideOtherProject({ href = "", home = "", inSidebar = false } = {}) {
  return Boolean(inSidebar && home && isOtherProjectUrl(href, home));
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

/** In-page script: CSS hide + click block + location bounce. Parameterized per seat. */
export function projectJailScript(home) {
  const locked = canonicalizeProjectUrl(home);
  if (!locked) return "void 0";
  return `(() => {
    if (window.__gpcProjectJail && window.__gpcProjectJail.home === ${JSON.stringify(locked)}) return;
    const HOME = ${JSON.stringify(locked)};
    const PROJECT_RE = /\\/g\\/(g-p-[^/?#]+)/i;
    const AUTH_HOSTS = new Set(${JSON.stringify([...AUTH_HOSTS])});
    const CHATGPT_HOSTS = new Set(${JSON.stringify([...CHATGPT_HOSTS])});
    const AUTH_PATH_RE = ${AUTH_PATH_RE};
    const ASSET_EXT_RE = ${ASSET_EXT_RE};
    const CONTROL = 'a, button, [role="link"], [role="button"], [role="menuitem"], [role="tab"]';

    const parse = (href, base) => { try { return new URL(String(href || ""), base || location.href); } catch { return null; } };
    const tokenOf = (href) => {
      const url = parse(href);
      const m = String(url?.pathname || "").match(PROJECT_RE);
      return m ? m[1].toLowerCase() : "";
    };
    const homeToken = tokenOf(HOME);
    const isOwn = (href) => {
      const t = tokenOf(href);
      return !!(t && homeToken && t === homeToken);
    };
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
      const path = (url.pathname || "/").replace(/\\/+$/, "") || "/";
      if (AUTH_HOSTS.has(host)) return true;
      if (CHATGPT_HOSTS.has(host) && AUTH_PATH_RE.test(path)) return true;
      return isOwn(href);
    };
    const bounceTo = (href) => (isAllowed(href) ? null : HOME);
    const enforce = () => {
      const next = bounceTo(location.href);
      if (next && next !== location.href) location.replace(next);
    };
    const hrefOf = (el) => el?.href || el?.getAttribute?.("href") || el?.getAttribute?.("data-href") || "";
    const inSidebar = (el) => Boolean(el?.closest?.("nav, aside, [class*='sidebar' i], [class*='side-bar' i], [class*='project' i]"));
    const hide = (el) => {
      if (!el || el.getAttribute("data-gpc-hidden-project") === "1") return;
      el.setAttribute("data-gpc-hidden-project", "1");
      el.setAttribute("aria-hidden", "true");
      el.setAttribute("tabindex", "-1");
      el.style.setProperty("display", "none", "important");
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("pointer-events", "none", "important");
    };
    const hideOther = (root) => {
      const scope = root && root.querySelectorAll ? root : document;
      const nodes = scope.querySelectorAll(CONTROL);
      for (const el of nodes) {
        if (inSidebar(el) && isOther(hrefOf(el))) hide(el);
      }
      if (root && root.matches?.(CONTROL) && inSidebar(root) && isOther(hrefOf(root))) hide(root);
    };
    const blockEvent = (event) => {
      const control = event.target?.closest?.(CONTROL);
      if (!control || !isOther(hrefOf(control))) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      enforce();
    };

    window.__gpcProjectJail = { home: HOME };
    hideOther(document);
    enforce();
    document.addEventListener("click", blockEvent, true);
    document.addEventListener("auxclick", blockEvent, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      blockEvent(event);
    }, true);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) hideOther(record.target);
        for (const node of record.addedNodes) {
          if (node instanceof Element) hideOther(node);
        }
      }
    });
    const start = () => {
      observer.observe(document.documentElement || document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["href", "aria-label", "title", "role"],
      });
      hideOther(document);
    };
    if (document.documentElement) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
    window.addEventListener("popstate", enforce);
    window.addEventListener("hashchange", enforce);
    if (globalThis.navigation?.addEventListener) {
      globalThis.navigation.addEventListener("navigate", (event) => {
        const dest = event.destination?.url;
        if (!dest || isAllowed(dest)) return;
        if (typeof event.preventDefault === "function") event.preventDefault();
        location.replace(HOME);
      });
    }
    setInterval(enforce, 800);
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
 * On other-project / off-project navigation, Page.navigate back to home.
 */
export async function armSeatJail({ send, on, sessionId, homeUrl } = {}) {
  const home = canonicalizeProjectUrl(homeUrl);
  if (!home || typeof send !== "function") return { armed: false, home: "", dispose() {} };

  const script = projectJailScript(home);
  await send("Page.enable", {}, sessionId);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sessionId);
  try {
    await send("Runtime.evaluate", { expression: script, returnByValue: true }, sessionId);
  } catch {
    /* current document may not be ready */
  }
  try {
    const loc = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
    const href = loc?.result?.value || loc;
    const bounce = bounceUrl(typeof href === "string" ? href : "", home);
    if (bounce) await send("Page.navigate", { url: bounce }, sessionId);
  } catch {
    /* navigate is best-effort */
  }

  const dispose =
    typeof on === "function"
      ? on((msg) => {
          if (sessionId && msg.sessionId && msg.sessionId !== sessionId) return;
          if (!isMainFrameNav(msg)) return;
          const next = bounceUrl(jailNavUrl(msg), home);
          if (!next) return;
          send("Page.navigate", { url: next }, sessionId).catch(() => {});
        })
      : () => {};

  return {
    armed: true,
    home,
    dispose: typeof dispose === "function" ? dispose : () => {},
  };
}

export async function startSeatProjectJail(deskId, targetId, homeUrl, opts = {}) {
  const home = canonicalizeProjectUrl(homeUrl);
  if (!deskId || !targetId || !home) return { armed: false, home: "", dispose() {} };
  const attached = await attachSeatTarget(deskId, targetId, opts);
  const armed = await armSeatJail({
    send: (method, params) => attached.cdp.send(method, params, attached.sessionId),
    on: (fn) => attached.cdp.on(fn),
    sessionId: attached.sessionId,
    homeUrl: home,
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
      if (existing?.home === home) return existing;
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
