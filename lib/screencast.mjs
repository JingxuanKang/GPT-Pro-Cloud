/**
 * Stream one CDP target to one member. Frames come from Page.startScreencast
 * (page viewport only — no tab strip). Pointer / keyboard go back as Input.*.
 */
import { attachSeatTarget } from "./cdp.mjs";
import { applyTabPastePlan, tabPasteFromMessage } from "./tab-paste.mjs";
import { armSeatJail, isBlockedJailChord } from "./project-jail.mjs";
import { armFileChooser, fileChooserClientMessage } from "./file-chooser.mjs";

export const KEY_CODES = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  " ": 32,
};

export function modifierBits({ alt, ctrl, meta, shift } = {}) {
  return (alt ? 1 : 0) + (ctrl ? 2 : 0) + (meta ? 4 : 0) + (shift ? 8 : 0);
}

export function pointerToCdp(clientX, clientY, view, meta) {
  const vw = Number(view?.width) || 1;
  const vh = Number(view?.height) || 1;
  const dw = Number(meta?.deviceWidth) || vw;
  const dh = Number(meta?.deviceHeight) || vh;
  return {
    x: (Number(clientX) / vw) * dw,
    y: (Number(clientY) / vh) * dh,
  };
}

export function keyEventParams(msg) {
  const key = String(msg?.key || "");
  const code = String(msg?.code || "");
  const modifiers = Number(msg?.modifiers || 0);
  const vk = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const type = msg?.event === "keyUp" ? "keyUp" : key.length === 1 ? "keyDown" : "rawKeyDown";
  const params = {
    type,
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
  };
  if (msg?.event !== "keyUp" && key.length === 1 && !(modifiers & 2) && !(modifiers & 4)) {
    params.text = key;
    params.unmodifiedText = key;
  }
  return params;
}

export function mouseEventParams(msg, view, meta) {
  const { x, y } = pointerToCdp(msg?.x, msg?.y, view, meta);
  const type = String(msg?.event || "mouseMoved");
  const button = String(msg?.button || (type === "mouseMoved" ? "none" : "left"));
  const params = {
    type,
    x,
    y,
    button,
    clickCount: Number(msg?.clickCount || (type === "mousePressed" || type === "mouseReleased" ? 1 : 0)),
    modifiers: Number(msg?.modifiers || 0),
  };
  if (type === "mouseWheel") {
    params.deltaX = Number(msg?.deltaX || 0);
    params.deltaY = Number(msg?.deltaY || 0);
  }
  return params;
}

/** Strip anything the client must not see (other targets, debugger URLs). */
export function clientStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.type === "frame") {
    return {
      type: "frame",
      data: String(msg.data || ""),
      metadata: {
        deviceWidth: Number(msg.metadata?.deviceWidth || 0),
        deviceHeight: Number(msg.metadata?.deviceHeight || 0),
        offsetTop: Number(msg.metadata?.offsetTop || 0),
        pageScaleFactor: Number(msg.metadata?.pageScaleFactor || 1),
      },
    };
  }
  if (msg.type === "error") return { type: "error", error: String(msg.error || "分屏中断") };
  if (msg.type === "ready") return { type: "ready", mode: "tab" };
  return fileChooserClientMessage(msg);
}

function sendJson(ws, obj) {
  const safe = clientStreamMessage(obj) || obj;
  if (!safe) return;
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(safe));
  } catch {
    /* ignore */
  }
}

export async function startSeatScreencast({
  ws,
  seat,
  attach = attachSeatTarget,
  quality = 55,
  choosers = null,
} = {}) {
  if (!seat?.targetId || !seat.deskId) {
    sendJson(ws, { type: "error", error: "没有分屏目标" });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return { close() {} };
  }

  let cdp;
  let sessionId;
  let releaseAttach;
  let jail;
  let fileWatch;
  let view = { width: 1280, height: 800 };
  let meta = { deviceWidth: 1280, deviceHeight: 800 };
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    off?.();
    try {
      jail?.dispose?.();
    } catch {
      /* ignore */
    }
    try {
      fileWatch?.dispose?.();
    } catch {
      /* ignore */
    }
    choosers?.clear?.(seat.deskId, seat.userId);
    if (cdp && sessionId) {
      cdp.send("Page.stopScreencast", {}, sessionId).catch(() => {});
    }
    Promise.resolve(releaseAttach?.()).catch(() => {});
  };

  let off;
  try {
    const attached = await attach(seat.deskId, seat.targetId);
    cdp = attached.cdp;
    sessionId = attached.sessionId;
    releaseAttach = attached.release;
    if (attached.targetId && attached.targetId !== seat.targetId) {
      teardown();
      sendJson(ws, { type: "error", error: "分屏目标不匹配" });
      ws.close();
      return { close: teardown };
    }
  } catch (e) {
    sendJson(ws, { type: "error", error: e.message || "无法连接分屏席位" });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return { close: teardown };
  }

  const sendOnSession = (method, params) => cdp.send(method, params, sessionId);

  off = cdp.on((msg) => {
    if (closed) return;
    if (msg.sessionId && msg.sessionId !== sessionId) return;
    if (msg.method === "Page.fileChooserOpened") return;
    if (msg.method !== "Page.screencastFrame") return;
    const params = msg.params || {};
    meta = {
      deviceWidth: params.metadata?.deviceWidth || meta.deviceWidth,
      deviceHeight: params.metadata?.deviceHeight || meta.deviceHeight,
      offsetTop: params.metadata?.offsetTop || 0,
      pageScaleFactor: params.metadata?.pageScaleFactor || 1,
    };
    sendJson(ws, { type: "frame", data: params.data || "", metadata: meta });
    sendOnSession("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  });

  const applySize = async (width, height) => {
    const w = Math.max(320, Math.min(2560, Math.round(Number(width) || 1280)));
    const h = Math.max(320, Math.min(1600, Math.round(Number(height) || 800)));
    view = { width: w, height: h };
    try {
      await sendOnSession("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sendOnSession("Page.startScreencast", {
        format: "jpeg",
        quality,
        maxWidth: w,
        maxHeight: h,
        everyNthFrame: 1,
      });
    } catch {
      /* viewport is best-effort */
    }
  };

  try {
    await sendOnSession("Page.enable", {});
    jail = await armSeatJail({
      send: (method, params, sid) => (sid ? cdp.send(method, params, sid) : cdp.send(method, params)),
      on: (fn) => cdp.on(fn),
      sessionId,
      homeUrl: seat.projectUrl || "",
      targetId: seat.targetId,
    });
    fileWatch = await armFileChooser({
      send: (method, params, sid) => (sid ? cdp.send(method, params, sid) : cdp.send(method, params)),
      on: (fn) => cdp.on(fn),
      sessionId,
      onOpened: (info) => {
        choosers?.set?.(seat.deskId, seat.userId, { ...info, targetId: seat.targetId });
        sendJson(ws, { type: "file-chooser", mode: info.mode });
      },
    });
    await applySize(1280, 800);
    sendJson(ws, { type: "ready", mode: "tab" });
  } catch (e) {
    sendJson(ws, { type: "error", error: e.message || "无法开始分屏" });
    teardown();
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    return { close: teardown };
  }

  const onMessage = async (raw) => {
    if (closed) return;
    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw?.data || raw));
    } catch {
      return;
    }
    try {
      if (msg.type === "size") {
        await applySize(msg.width, msg.height);
        return;
      }
      if (msg.type === "mouse") {
        await sendOnSession("Input.dispatchMouseEvent", mouseEventParams(msg, view, meta));
        return;
      }
      if (msg.type === "key") {
        if (isBlockedJailChord(msg)) return;
        const params = keyEventParams(msg);
        if (params.type === "keyDown" && params.text) {
          await sendOnSession("Input.dispatchKeyEvent", { ...params, type: "char" });
        }
        return;
      }
      if (msg.type === "paste") {
        const plan = tabPasteFromMessage(msg);
        const out = await applyTabPastePlan(sendOnSession, plan);
        if (!out.ok) sendJson(ws, { type: "error", error: out.error || "无法粘贴" });
      }
    } catch {
      /* input is best-effort */
    }
  };

  if (typeof ws.on === "function") {
    ws.on("message", (data) => {
      onMessage(typeof data === "string" ? data : data.toString()).catch(() => {});
    });
    ws.on("close", teardown);
    ws.on("error", teardown);
  } else if (typeof ws.addEventListener === "function") {
    ws.addEventListener("message", (ev) => onMessage(ev.data).catch(() => {}));
    ws.addEventListener("close", teardown);
    ws.addEventListener("error", teardown);
  }

  return { close: teardown, applySize };
}
