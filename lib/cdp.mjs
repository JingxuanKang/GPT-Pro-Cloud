/** Chromium DevTools on the desk (9222 via cdp-fwd :9223). Same profile, no second browser. */

export const CHATGPT_START = "https://chatgpt.com";
export const PARKED_WINDOW_X = -8000;

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
    return /session-token/i.test(name) || /__Secure-next-auth\.session-token/i.test(name);
  });
}

export async function listDeskTargets(deskId, fetchImpl = fetch) {
  const r = await fetchImpl(`${deskCdpBase(deskId)}/json`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error("工作区还没准备好");
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

export async function deskBrowserWs(deskId, fetchImpl = fetch) {
  const r = await fetchImpl(`${deskCdpBase(deskId)}/json/version`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error("工作区还没准备好");
  const info = await r.json();
  if (!info?.webSocketDebuggerUrl) throw new Error("工作区还没准备好");
  return rewriteCdpWs(info.webSocketDebuggerUrl, deskId);
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
    send(method, params, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++n;
        pending.set(id, { resolve, reject });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        try {
          ws.send(JSON.stringify(payload));
        } catch (e) {
          pending.delete(id);
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

export async function waitForDeskPage(id, timeoutMs = 24000, { targetId, fetchImpl = fetch } = {}) {
  const t0 = Date.now();
  let last = "工作区还没准备好";
  while (Date.now() - t0 < timeoutMs) {
    try {
      const pages = await listDeskTargets(id, fetchImpl);
      let page;
      if (targetId) {
        page = pages.find((t) => t.id === targetId && t.webSocketDebuggerUrl);
      } else {
        page =
          pages.find((t) => t.type === "page" && /chatgpt\.com/i.test(t.url || "")) ||
          pages.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      }
      if (page?.webSocketDebuggerUrl) return page;
      last = "工作区还没准备好";
    } catch (e) {
      last = e.name === "TimeoutError" ? "工作区还没准备好" : e.message || "工作区还没准备好";
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(last);
}

export async function targetExists(deskId, targetId, fetchImpl = fetch) {
  if (!targetId) return false;
  try {
    const pages = await listDeskTargets(deskId, fetchImpl);
    return pages.some((t) => t.id === targetId);
  } catch {
    return false;
  }
}

export async function deskHasChatGPTSession(deskId, { fetchImpl = fetch, connect = createCdpConnection } = {}) {
  const pages = await listDeskTargets(deskId, fetchImpl);
  const page = pages.find((t) => t.webSocketDebuggerUrl);
  if (!page) return false;
  const cdp = connect(rewriteCdpWs(page.webSocketDebuggerUrl, deskId));
  await cdp.ready;
  try {
    let cookies = [];
    try {
      const r = await cdp.send("Network.getAllCookies");
      cookies = r.cookies || [];
    } catch {
      const r = await cdp.send("Storage.getCookies");
      cookies = r.cookies || [];
    }
    return cookiesIndicateChatGPTSession(cookies);
  } catch {
    return false;
  } finally {
    cdp.close();
  }
}

export async function parkTargetWindow(cdp, targetId) {
  const win = await cdp.send("Browser.getWindowForTarget", { targetId });
  if (win?.windowId == null) return false;
  await cdp.send("Browser.setWindowBounds", {
    windowId: win.windowId,
    bounds: { left: PARKED_WINDOW_X, top: 0, width: 1280, height: 800, windowState: "normal" },
  });
  return true;
}

export async function createParkedChatGPTTab(
  deskId,
  { fetchImpl = fetch, connect = createCdpConnection, startUrl = CHATGPT_START } = {},
) {
  const browserWs = await deskBrowserWs(deskId, fetchImpl);
  const cdp = connect(browserWs);
  await cdp.ready;
  try {
    const created = await cdp.send("Target.createTarget", { url: startUrl, newWindow: true });
    const targetId = created?.targetId;
    if (!targetId) throw new Error("无法创建分屏席位");
    try {
      await parkTargetWindow(cdp, targetId);
    } catch {
      /* parking is best-effort; the member still only streams this target */
    }
    return { targetId };
  } finally {
    cdp.close();
  }
}

export async function closeTarget(deskId, targetId, { fetchImpl = fetch, connect = createCdpConnection } = {}) {
  if (!targetId) return false;
  const browserWs = await deskBrowserWs(deskId, fetchImpl);
  const cdp = connect(browserWs);
  await cdp.ready;
  try {
    await cdp.send("Target.closeTarget", { targetId });
    return true;
  } catch {
    return false;
  } finally {
    cdp.close();
  }
}

export async function attachSeatTarget(deskId, targetId, { fetchImpl = fetch, connect = createCdpConnection } = {}) {
  if (!targetId) throw new Error("没有分屏目标");
  const browserWs = await deskBrowserWs(deskId, fetchImpl);
  const cdp = connect(browserWs);
  await cdp.ready;
  const attached = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const sessionId = attached?.sessionId;
  if (!sessionId) {
    cdp.close();
    throw new Error("无法连接分屏席位");
  }
  return { cdp, sessionId, targetId };
}

export async function evaluateOnSession(cdp, sessionId, expression, timeoutMs = 28000) {
  const result = await Promise.race([
    cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("页面操作超时")), timeoutMs)),
  ]);
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "页面脚本出错");
  }
  return result?.result?.value;
}

export async function evaluateOnTarget(deskId, targetId, expression, timeoutMs = 28000, opts = {}) {
  const { cdp, sessionId } = await attachSeatTarget(deskId, targetId, opts);
  try {
    return await evaluateOnSession(cdp, sessionId, expression, timeoutMs);
  } finally {
    cdp.close();
  }
}
