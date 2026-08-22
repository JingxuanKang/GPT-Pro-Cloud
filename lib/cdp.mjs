/** Chromium DevTools on the desk (9222 via cdp-fwd :9223). Same profile, no second browser. */

export const CHATGPT_START = "https://chatgpt.com";
export const PARKED_WINDOW_X = -8000;

/** Flags that make the debug port visible to the page. Only when 多人分屏 is on. */
export function chromiumCdpArgs(enabled) {
  if (!enabled) return [];
  return [
    "--remote-debugging-port=9222",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
  ];
}

export function parseCdpFlag(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "on" || s === "yes";
}

export function deskClipdCdpUrl(id) {
  return `http://desktop-${id}:18790/cdp`;
}

/** clipd POST /cdp — write /config/.gpc-cdp and restart Chromium. */
export async function applyDeskCdpLive(id, on, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(deskClipdCdpUrl(id), {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: on ? "1" : "0",
  });
  if (!r.ok) throw new Error("cdp live apply failed");
}

function closeWs(ws) {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
}

export function deskCdpBase(id) {
  return `http://desktop-${id}:9223`;
}

export function rewriteCdpWs(url, deskId) {
  return String(url || "").replace(/127\.0\.0\.1:9222|localhost:9222/g, `desktop-${deskId}:9223`);
}

export function isChatGPTPage(t) {
  return !!(t && t.type === "page" && /chatgpt\.com|openai\.com|auth\.openai\.com/i.test(t.url || ""));
}

/** Session cookie names that mean someone has already signed in to ChatGPT. */
export function cookiesIndicateChatGPTSession(cookies) {
  return (Array.isArray(cookies) ? cookies : []).some((c) => {
    const name = String(c?.name || "");
    return /session-token(\.\d+)?$/i.test(name) || /__Secure-next-auth\.session-token(\.\d+)?$/i.test(name);
  });
}

/**
 * Cookie-name probe wins when cookies were listed.
 * A connect/debugger failure without cookies is unknown (null), not "logged out".
 */
export function sessionFromProbe({ cookies, error } = {}) {
  if (Array.isArray(cookies)) {
    return { known: true, hasSession: cookiesIndicateChatGPTSession(cookies) };
  }
  if (error) return { known: false, hasSession: null, error: error.message || String(error) };
  return { known: false, hasSession: null };
}

export async function deskBrowserWs(deskId, fetchImpl = fetch) {
  const r = await fetchImpl(`${deskCdpBase(deskId)}/json/version`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error("工作区还没准备好");
  const info = await r.json();
  if (!info?.webSocketDebuggerUrl) throw new Error("工作区还没准备好");
  return rewriteCdpWs(info.webSocketDebuggerUrl, deskId);
}

export const CLOSE_TARGET_MS = 2000;
export const CDP_SEND_MS = 4000;

export function withDeadline(promise, ms, message) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/** HTTP PUT/GET /json/new — works even when a page debugger session is already attached. */
export function deskJsonNewUrl(deskId, startUrl = CHATGPT_START) {
  return `${deskCdpBase(deskId)}/json/new?${encodeURIComponent(startUrl)}`;
}

export function targetIdFromJsonNew(info) {
  if (typeof info === "string" && info.trim()) return info.trim();
  if (info && typeof info === "object") {
    const id = info.id || info.targetId;
    if (id) return String(id);
  }
  return "";
}

export async function createTargetViaHttp(deskId, startUrl = CHATGPT_START, fetchImpl = fetch) {
  const url = deskJsonNewUrl(deskId, startUrl);
  let last = "无法创建分屏席位";
  for (const method of ["PUT", "GET"]) {
    try {
      const r = await fetchImpl(url, { method, signal: AbortSignal.timeout(2500) });
      if (!r.ok) {
        last = "工作区还没准备好";
        continue;
      }
      const info = await r.json();
      const targetId = targetIdFromJsonNew(info);
      if (targetId) return { targetId };
      last = "无法创建分屏席位";
    } catch (e) {
      last = e.name === "TimeoutError" ? "工作区还没准备好" : e.message || last;
    }
  }
  throw new Error(last);
}

export function createCdpConnection(wsUrl, timeoutMs = 8000) {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  const pending = new Map();
  const listeners = new Set();

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "cdp error"));
      else resolve(msg.result || {});
      return;
    }
    for (const fn of listeners) {
      try {
        fn(msg);
      } catch {
        /* ignore listener errors */
      }
    }
  });

  const ready = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("无法连接页面")), timeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(t);
        reject(new Error("无法连接页面"));
      },
      { once: true },
    );
  });

  return {
    ready,
    ws,
    send(method, params, sessionId, timeoutMs = CDP_SEND_MS) {
      return new Promise((resolve, reject) => {
        const id = ++n;
        const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : CDP_SEND_MS;
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error("页面操作超时"));
        }, ms);
        const finish = (fn, value) => {
          clearTimeout(timer);
          fn(value);
        };
        pending.set(id, {
          resolve: (value) => finish(resolve, value),
          reject: (err) => finish(reject, err),
        });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        try {
          ws.send(JSON.stringify(payload));
        } catch (e) {
          pending.delete(id);
          clearTimeout(timer);
          reject(e);
        }
      });
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close() {
      for (const { reject } of pending.values()) reject(new Error("cdp closed"));
      pending.clear();
      closeWs(ws);
    },
  };
}

function wsOpen(cdp) {
  const state = cdp?.ws?.readyState;
  return state == null || state === 1;
}

/**
 * One shared control socket per desk for short Target.* / cookie calls.
 * Seat streams open a dedicated browser WS (same cached URL, new socket)
 * so two Page.startScreencast sessions never share one connection.
 * Chromium's inspector HTTP (/json/version, /json) 500s after a couple of hits
 * (phoenix). Cache the WS URL, single-flight the first connect, reuse it.
 */
export function createDeskBrowserPool() {
  const slots = new Map();
  const urls = new Map();

  function forget(deskId) {
    const slot = slots.get(deskId);
    slots.delete(deskId);
    urls.delete(deskId);
    try {
      slot?.cdp?.dispose?.();
    } catch {
      /* ignore */
    }
  }

  async function resolveUrl(deskId, fetchImpl, { refresh = false } = {}) {
    if (refresh) urls.delete(deskId);
    let url = urls.get(deskId);
    if (!url) {
      url = await deskBrowserWs(deskId, fetchImpl);
      urls.set(deskId, url);
    }
    return url;
  }

  async function open(deskId, { fetchImpl, connect }) {
    const url = await resolveUrl(deskId, fetchImpl);
    const cdp = connect(url);
    await cdp.ready;
    const rawClose = cdp.close.bind(cdp);
    cdp.close = () => {};
    cdp.dispose = () => {
      rawClose();
      if (slots.get(deskId)?.cdp === cdp) slots.delete(deskId);
    };
    cdp.ws?.addEventListener?.("close", () => {
      if (slots.get(deskId)?.cdp === cdp) slots.delete(deskId);
    });
    return { cdp, url };
  }

  /** New browser-level WS. Caller owns close(). Does not touch the shared slot. */
  async function connectDedicated(deskId, { fetchImpl = fetch, connect = createCdpConnection } = {}) {
    const openOnce = async (refresh) => {
      const url = await resolveUrl(deskId, fetchImpl, { refresh });
      const cdp = connect(url);
      await cdp.ready;
      return cdp;
    };
    try {
      return await openOnce(false);
    } catch {
      return await openOnce(true);
    }
  }

  async function get(deskId, { fetchImpl = fetch, connect = createCdpConnection } = {}) {
    const existing = slots.get(deskId);
    if (existing) {
      const s = await existing.ready;
      if (s.cdp && wsOpen(s.cdp)) return s.cdp;
      if (slots.get(deskId) === existing) slots.delete(deskId);
    }
    const slot = {};
    slot.ready = open(deskId, { fetchImpl, connect })
      .then((s) => {
        slot.cdp = s.cdp;
        return s;
      })
      .catch((e) => {
        if (slots.get(deskId) === slot) {
          slots.delete(deskId);
          urls.delete(deskId);
        }
        throw e;
      });
    slots.set(deskId, slot);
    const s = await slot.ready;
    return s.cdp;
  }

  return { get, forget, connectDedicated, urls, slots };
}

export const deskBrowsers = createDeskBrowserPool();

export function forgetDeskBrowser(deskId, pool = deskBrowsers) {
  pool.forget(deskId);
}

export async function listDeskTargets(deskId, fetchImpl = fetch, opts = {}) {
  const pool = opts.pool || deskBrowsers;
  const cdp = await pool.get(deskId, { fetchImpl, connect: opts.connect });
  const r = await cdp.send("Target.getTargets");
  return (r.targetInfos || []).map((t) => ({
    id: t.targetId || t.id,
    type: t.type || "page",
    url: t.url || "",
    title: t.title || "",
  }));
}

export async function waitForDeskPage(id, timeoutMs = 24000, { targetId, fetchImpl = fetch, connect, pool } = {}) {
  const t0 = Date.now();
  let last = "工作区还没准备好";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const pages = await listDeskTargets(id, fetchImpl, { connect, pool });
      let page;
      if (targetId) {
        page = pages.find((t) => t.id === targetId);
      } else {
        page =
          pages.find((t) => t.type === "page" && /chatgpt\.com/i.test(t.url || "")) ||
          pages.find((t) => t.type === "page");
      }
      if (page?.id) return page;
      last = "工作区还没准备好";
    } catch (e) {
      last = e.name === "TimeoutError" ? "工作区还没准备好" : e.message || "工作区还没准备好";
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(last);
}

export async function targetExists(deskId, targetId, fetchImpl = fetch, opts = {}) {
  if (!targetId) return false;
  try {
    const pages = await listDeskTargets(deskId, fetchImpl, opts);
    return pages.some((t) => t.id === targetId);
  } catch {
    return false;
  }
}

/** Browser-level cookies — does not attach to a page target that onboard may hold. */
export async function listDeskCookies(deskId, { fetchImpl = fetch, connect = createCdpConnection, pool = deskBrowsers } = {}) {
  const cdp = await pool.get(deskId, { fetchImpl, connect });
  try {
    const r = await cdp.send("Network.getAllCookies");
    return r.cookies || [];
  } catch {
    const r = await cdp.send("Storage.getCookies");
    return r.cookies || [];
  }
}

export async function probeDeskSession(deskId, opts = {}) {
  try {
    const cookies = await listDeskCookies(deskId, opts);
    return sessionFromProbe({ cookies });
  } catch (error) {
    return sessionFromProbe({ error });
  }
}

/** true / false when cookies were listed; null when the debugger could not be reached. */
export async function deskHasChatGPTSession(deskId, opts = {}) {
  const probe = await probeDeskSession(deskId, opts);
  return probe.hasSession;
}

/** Off-screen bounds the autostart xdotool loop will leave alone (X <= -1000). */
export const PARKED_WINDOW_BOUNDS = {
  left: PARKED_WINDOW_X,
  top: 0,
  width: 1280,
  height: 800,
  windowState: "normal",
};

/**
 * Get a seat window off the admin VNC desktop without closing it.
 * Must drop fullscreen/maximized first — Openbox ignores left:-8000 on a
 * maximized window (phoenix: pile of member projects on admin enter).
 */
export async function parkTargetWindow(cdp, targetId) {
  const win = await cdp.send("Browser.getWindowForTarget", { targetId });
  if (win?.windowId == null) return false;
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { windowState: "normal" },
    });
  } catch {
    /* still try the off-screen move */
  }
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { ...PARKED_WINDOW_BOUNDS },
    });
    return true;
  } catch {
    try {
      await cdp.send("Browser.setWindowBounds", {
        windowId: win.windowId,
        bounds: { windowState: "minimized" },
      });
      return true;
    } catch {
      return false;
    }
  }
}

/** Keep an existing seat window; never createTarget or closeTarget. */
export async function parkSeatTarget(deskId, targetId, opts = {}) {
  if (!deskId || !targetId) return false;
  const fetchImpl = opts.fetchImpl || fetch;
  const live = await targetExists(deskId, targetId, fetchImpl, opts);
  if (!live) return false;
  try {
    const pool = opts.pool || deskBrowsers;
    const connect = opts.connect || createCdpConnection;
    const cdp = await pool.get(deskId, { fetchImpl, connect });
    return await parkTargetWindow(cdp, targetId);
  } catch {
    return false;
  }
}

/** In-process reservation so concurrent first-opens do not adopt the same target. */
const reservedTargets = new Set();

export function reservedTargetKey(deskId, targetId) {
  return `${deskId}:${targetId}`;
}

export function reserveTarget(deskId, targetId) {
  if (!deskId || !targetId) return false;
  const key = reservedTargetKey(deskId, targetId);
  if (reservedTargets.has(key)) return false;
  reservedTargets.add(key);
  return true;
}

export function releaseReservedTarget(deskId, targetId) {
  if (!deskId || !targetId) return;
  reservedTargets.delete(reservedTargetKey(deskId, targetId));
}

export function reservedIdsForDesk(deskId) {
  if (!deskId) return [];
  const prefix = `${deskId}:`;
  const out = [];
  for (const key of reservedTargets) {
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

function claimedSet(ids) {
  return new Set((ids || []).filter(Boolean));
}

/** Prefer an existing chatgpt.com page that no seat already owns. */
export function pickUnclaimedChatGPTTarget(targets, { claimedTargetIds = [], reservedKeys = reservedTargets, deskId } = {}) {
  const claimed = claimedSet(claimedTargetIds);
  for (const t of targets || []) {
    if (!isChatGPTPage(t) || !t.id || claimed.has(t.id)) continue;
    if (deskId && reservedKeys.has(reservedTargetKey(deskId, t.id))) continue;
    return t;
  }
  return null;
}

export function pageTargetIds(targets) {
  return (targets || [])
    .map((t) => ({ id: t.id || t.targetId, type: t.type || "page" }))
    .filter((t) => t.type === "page" && t.id)
    .map((t) => t.id);
}

/** Closing the last/only page ends Chromium (especially --app). */
export function isLastPageTarget(targets, _targetId) {
  return pageTargetIds(targets).length <= 1;
}

export async function createParkedChatGPTTab(
  deskId,
  {
    fetchImpl = fetch,
    connect = createCdpConnection,
    startUrl = CHATGPT_START,
    pool = deskBrowsers,
    claimedTargetIds = [],
  } = {},
) {
  void claimedTargetIds;
  try {
    const cdp = await pool.get(deskId, { fetchImpl, connect });
    // Never adopt/park/tab-ify the primary or only window — that ends --app
    // and steals the admin desktop. Seat always gets a new window.
    let created;
    try {
      created = await withDeadline(
        cdp.send("Target.createTarget", { url: startUrl, newWindow: true, background: true }),
        4000,
        "无法创建分屏席位",
      );
    } catch {
      created = await withDeadline(
        cdp.send("Target.createTarget", { url: startUrl, newWindow: true }),
        4000,
        "无法创建分屏席位",
      );
    }
    const targetId = created?.targetId;
    if (!targetId) throw new Error("无法创建分屏席位");
    reserveTarget(deskId, targetId);
    try {
      await parkTargetWindow(cdp, targetId);
    } catch {
      /* parking is best-effort */
    }
    return { targetId };
  } catch (first) {
    try {
      const viaHttp = await createTargetViaHttp(deskId, startUrl, fetchImpl);
      reserveTarget(deskId, viaHttp.targetId);
      return viaHttp;
    } catch {
      throw first;
    }
  }
}

export async function closeTarget(deskId, targetId, { fetchImpl = fetch, connect = createCdpConnection, pool = deskBrowsers, timeoutMs = CLOSE_TARGET_MS } = {}) {
  if (!targetId) return false;
  releaseReservedTarget(deskId, targetId);
  try {
    return await withDeadline(
      (async () => {
        const cdp = await pool.get(deskId, { fetchImpl, connect });
        let listed;
        try {
          listed = await cdp.send("Target.getTargets");
        } catch {
          listed = { targetInfos: [] };
        }
        const pages = (listed.targetInfos || []).map((t) => ({
          id: t.targetId || t.id,
          type: t.type || "page",
        }));
        if (isLastPageTarget(pages, targetId)) return false;
        await cdp.send("Target.closeTarget", { targetId });
        return true;
      })(),
      timeoutMs,
      "关闭分屏窗口超时",
    );
  } catch {
    return false;
  }
}

function closeDedicated(cdp) {
  try {
    cdp.dispose?.() || cdp.close?.();
  } catch {
    /* ignore */
  }
}

/**
 * Flattened session on a dedicated browser WS (not the shared control slot).
 * Two members can screencast two targets at once; /open is not on this socket.
 */
export async function attachSeatTarget(deskId, targetId, { fetchImpl = fetch, connect = createCdpConnection, pool = deskBrowsers, shared = false } = {}) {
  if (!targetId) throw new Error("没有分屏目标");
  const dedicated = !shared && typeof pool.connectDedicated === "function";
  const cdp = dedicated
    ? await pool.connectDedicated(deskId, { fetchImpl, connect })
    : await pool.get(deskId, { fetchImpl, connect });
  try {
    const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attached?.sessionId;
    if (!sessionId) throw new Error("无法连接分屏席位");
    const release = async () => {
      await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      if (dedicated) closeDedicated(cdp);
    };
    return { cdp, sessionId, targetId, release, dedicated };
  } catch (e) {
    if (dedicated) closeDedicated(cdp);
    throw e;
  }
}

export async function evaluateOnSession(cdp, sessionId, expression, timeoutMs = 28000) {
  const result = await Promise.race([
    cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs,
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("页面操作超时")), timeoutMs)),
  ]);
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "页面脚本出错");
  }
  return result?.result?.value;
}

export async function evaluateOnTarget(deskId, targetId, expression, timeoutMs = 28000, opts = {}) {
  const { cdp, sessionId, release } = await attachSeatTarget(deskId, targetId, opts);
  try {
    return await evaluateOnSession(cdp, sessionId, expression, timeoutMs);
  } finally {
    await release();
  }
}
