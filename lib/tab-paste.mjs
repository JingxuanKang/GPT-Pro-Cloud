/**
 * Tab-seat paste. Text uses CDP Input.insertText. Images dispatch a synthetic
 * ClipboardEvent on document.activeElement (contenteditable / textarea / input).
 * Never writes the shared desk clipboard — that would leak to the other seat.
 */

export const TAB_PASTE_TEXT_MAX = 64 * 1024;
export const TAB_PASTE_IMAGE_MAX = 4 * 1024 * 1024;
export const TAB_PASTE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const TAB_PASTE_NEED_FOCUS = "点一下输入框再粘贴";

function mimeOf(contentType) {
  const ct = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (ct === "image/jpg") return "image/jpeg";
  return ct;
}

export function filenameForMime(mime) {
  if (mime === "image/jpeg") return "image.jpg";
  if (mime === "image/webp") return "image.webp";
  return "image.png";
}

export function classifyTabPaste(contentType, byteLength) {
  const mime = mimeOf(contentType);
  const n = Number(byteLength) || 0;
  if (!n) return { error: "空内容", status: 400 };
  if (mime.startsWith("text/") || mime === "" || mime === "application/json") {
    if (n > TAB_PASTE_TEXT_MAX) return { error: "太大了", status: 413 };
    return { kind: "text", mime: mime || "text/plain" };
  }
  if (TAB_PASTE_IMAGE_TYPES.includes(mime)) {
    if (n > TAB_PASTE_IMAGE_MAX) return { error: "太大了", status: 413 };
    return { kind: "image", mime };
  }
  return { error: "分屏席位只支持文字和图片（png/jpeg/webp）", status: 400 };
}

/**
 * Runtime.evaluate body. Uses document.activeElement only — no chatgpt.com
 * class names or composer selectors. If nothing pasteable is focused, returns
 * { error: "need-focus" } so the UI can say TAB_PASTE_NEED_FOCUS.
 */
export function imagePasteExpression({ mime, base64, filename } = {}) {
  const m = JSON.stringify(String(mime || "image/png"));
  const b = JSON.stringify(String(base64 || ""));
  const n = JSON.stringify(String(filename || filenameForMime(mime)));
  return `(() => {
    const mime = ${m};
    const b64 = ${b};
    const name = ${n};
    const el = document.activeElement;
    const tag = el && el.tagName ? String(el.tagName).toUpperCase() : "";
    const type = el && el.type != null ? String(el.type) : "text";
    const focused = !!(
      el &&
      el !== document.body &&
      el !== document.documentElement &&
      (
        el.isContentEditable === true ||
        tag === "TEXTAREA" ||
        (tag === "INPUT" && /^(text|search|url|email|password|tel|number)?$/i.test(type))
      )
    );
    if (!focused) return { ok: false, error: "need-focus" };
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    let ev;
    try {
      ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
    } catch (e) {
      ev = new Event("paste", { bubbles: true, cancelable: true });
    }
    if (!ev.clipboardData) {
      Object.defineProperty(ev, "clipboardData", { value: dt, configurable: true });
    }
    el.dispatchEvent(ev);
    return { ok: true, kind: "image" };
  })()`;
}

export function tabPastePlan(contentType, bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const classified = classifyTabPaste(contentType, buf.length);
  if (classified.error) return classified;
  if (classified.kind === "text") {
    return {
      kind: "text",
      method: "Input.insertText",
      params: { text: buf.toString("utf8").slice(0, TAB_PASTE_TEXT_MAX) },
    };
  }
  return {
    kind: "image",
    method: "Runtime.evaluate",
    params: {
      expression: imagePasteExpression({
        mime: classified.mime,
        base64: buf.toString("base64"),
        filename: filenameForMime(classified.mime),
      }),
      awaitPromise: true,
      returnByValue: true,
    },
  };
}

export function interpretTabPasteEvaluate(value) {
  if (value?.ok) return { ok: true, kind: value.kind || "image" };
  if (value?.error === "need-focus") {
    return { ok: false, error: TAB_PASTE_NEED_FOCUS, status: 400, code: "TAB_PASTE_NEED_FOCUS" };
  }
  return { ok: false, error: value?.error || "无法粘贴", status: 502 };
}

export async function applyTabPastePlan(send, plan) {
  if (!plan || plan.error) {
    return { ok: false, error: plan?.error || "无法粘贴", status: plan?.status || 400 };
  }
  if (plan.kind === "text") {
    await send("Input.insertText", plan.params);
    return { ok: true, kind: "text" };
  }
  const raw = await send("Runtime.evaluate", plan.params);
  if (raw?.exceptionDetails) return { ok: false, error: "无法粘贴", status: 502 };
  return interpretTabPasteEvaluate(raw?.result?.value ?? raw);
}

export function tabPasteFromMessage(msg) {
  if (!msg || msg.type !== "paste") return null;
  if (typeof msg.text === "string") {
    return tabPastePlan("text/plain; charset=utf-8", Buffer.from(msg.text, "utf8"));
  }
  if (typeof msg.image === "string") {
    return tabPastePlan(msg.mime || "image/png", Buffer.from(msg.image, "base64"));
  }
  return { error: "空内容", status: 400 };
}
