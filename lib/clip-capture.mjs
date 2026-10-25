/**
 * ChatGPT's own Copy / Copy link writes the async clipboard inside the desk
 * Chromium. That write often never reaches the member: noVNC only syncs text,
 * and Linux Chromium frequently rejects image clipboard writes when the
 * window is unfocused. This hook keeps the bytes (and share URL) on the page
 * so the gateway can hand them to the member's browser. It does not fetch
 * chatgpt.com from the gateway and does not open another account.
 */
import { createHash } from "node:crypto";

export const CLIP_HOOK_VER = 1;
export const CLIP_IMAGE_MAX = 4 * 1024 * 1024;

/** Share-page URLs and public image file URLs ChatGPT puts on the clipboard. */
export const SHARE_URL_SRC =
  String.raw`https:\/\/(?:(?:chatgpt\.com|chat\.openai\.com)\/(?:share|s)\/[A-Za-z0-9_-]+(?:[/?#][^\s"'<>]*)?|(?:files\.)?oaiusercontent\.com\/[^\s"'<>]+)`;

export function extractShareUrl(text) {
  const m = String(text || "").match(new RegExp(SHARE_URL_SRC, "i"));
  if (!m) return "";
  return m[0].replace(/[),.;]+$/g, "");
}

export function isShareUrl(text) {
  const token = String(text || "")
    .trim()
    .split(/\s+/)[0]
    .replace(/[),.;]+$/g, "");
  if (!token) return false;
  const found = extractShareUrl(token);
  return !!found && (found === token || token.startsWith(found));
}

export function normalizeImageMime(mime) {
  const m = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (m === "image/jpg" || m === "image/jpeg") return "image/jpeg";
  if (m === "image/png" || m === "image/webp") return m;
  return "";
}

export function imageMagicOk(mime, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (mime === "image/png") return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (mime === "image/jpeg") return buf[0] === 0xff && buf[1] === 0xd8;
  if (mime === "image/webp") return buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

export function clipPayloadFromCapture(raw) {
  if (!raw || typeof raw !== "object" || raw.unchanged || raw.missing) return null;
  const seq = Number(raw.seq) || 0;
  if (!seq) return null;
  const text = extractShareUrl(raw.text || "");
  if (raw.kind === "image" && raw.b64) {
    const buf = Buffer.from(String(raw.b64).replace(/\s+/g, ""), "base64");
    const mime = normalizeImageMime(raw.mime);
    if (mime && buf.length && buf.length <= CLIP_IMAGE_MAX && imageMagicOk(mime, buf)) {
      return { kind: "image", seq, mime, buf, text };
    }
    if (text) return { kind: "text", seq, text };
    return null;
  }
  if (!text) return null;
  return { kind: "text", seq, text };
}

export function clipPayloadFromBytes({ mime, buf, share } = {}) {
  const header = extractShareUrl(share || "");
  const asText = buf && !String(mime || "").startsWith("image/") ? extractShareUrl(buf.toString("utf8")) : "";
  const text = header || asText;
  const norm = normalizeImageMime(mime);
  if (norm && Buffer.isBuffer(buf) && buf.length && buf.length <= CLIP_IMAGE_MAX && imageMagicOk(norm, buf)) {
    return { kind: "image", seq: 0, mime: norm, buf, text };
  }
  if (text) return { kind: "text", seq: 0, text };
  return null;
}

export function clipEtag(payload) {
  if (!payload) return "";
  if (payload.etag) return payload.etag;
  if (payload.seq) return `"cap-${payload.seq}"`;
  const basis = payload.kind === "image" ? payload.buf : Buffer.from(String(payload.text || ""));
  const digest = createHash("sha256").update(basis).digest("hex").slice(0, 16);
  return `"xclip-${digest}"`;
}

export function seenSeqFromEtag(etag) {
  const m = String(etag || "").match(/cap-(\d+)/);
  return m ? Number(m[1]) : 0;
}

export function shareHeaderValue(text) {
  const url = extractShareUrl(text);
  if (!url || /[^\x20-\x7e]/.test(url)) return "";
  return url;
}

export function clipCaptureReadExpression(seenSeq = 0) {
  const seen = Number(seenSeq) || 0;
  return `(() => {
    if (window.__gpcClipVer !== ${CLIP_HOOK_VER}) return { missing: true };
    const b = window.__gpcClipBox;
    if (!b || !b.seq) return null;
    if (${seen} && b.seq === ${seen}) return { seq: b.seq, unchanged: true };
    return {
      seq: b.seq,
      kind: b.kind || "",
      mime: b.mime || "",
      text: b.text || "",
      b64: b.kind === "image" ? (b.b64 || "") : "",
    };
  })()`;
}

export function pickGeneratedImageExpression() {
  return `(() => {
    if (typeof window.__gpcPickImage !== "function") return { ok: false, error: "画面还没准备好" };
    return window.__gpcPickImage();
  })()`;
}

export function clipCaptureSource() {
  const re = JSON.stringify(SHARE_URL_SRC);
  return `(() => {
    const VER = ${CLIP_HOOK_VER};
    if (window.__gpcClipVer === VER && typeof window.__gpcPickImage === "function") return;
    if (typeof window.__gpcClipUnhook === "function") {
      try { window.__gpcClipUnhook(); } catch (e) {}
    }
    const SHARE_RE = new RegExp(${re}, "i");
    const MAX = ${CLIP_IMAGE_MAX};
    const box = window.__gpcClipBox || { seq: 0, kind: "", mime: "", text: "", b64: "" };
    window.__gpcClipBox = box;
    const offs = [];
    const extract = (text) => {
      const m = String(text || "").match(SHARE_RE);
      return m ? m[0].replace(/[),.;]+$/g, "") : "";
    };
    const rememberText = (text) => {
      const share = extract(text);
      if (!share) return;
      box.seq += 1;
      box.kind = "text";
      box.mime = "text/plain";
      box.text = share;
      box.b64 = "";
    };
    const bytesToB64 = (bytes) => {
      let bin = "";
      const size = 8192;
      for (let i = 0; i < bytes.length; i += size) {
        const parts = new Array(Math.min(size, bytes.length - i));
        for (let j = 0; j < parts.length; j++) parts[j] = bytes[i + j];
        bin += String.fromCharCode.apply(null, parts);
      }
      return btoa(bin);
    };
    const blobToB64 = async (blob) => {
      if (!blob || blob.size > MAX) return "";
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length || bytes.length > MAX) return "";
      return bytesToB64(bytes);
    };
    const normMime = (t) => {
      const m = String(t || "").split(";")[0].trim().toLowerCase();
      if (m === "image/jpg" || m === "image/jpeg") return "image/jpeg";
      if (m === "image/png" || m === "image/webp") return m;
      return "";
    };
    const rememberImage = async (blob, text) => {
      let mime = normMime(blob && blob.type);
      if (!mime) {
        if (blob && !blob.type) mime = "image/png";
        else {
          if (text) rememberText(text);
          return;
        }
      }
      const b64 = await blobToB64(blob);
      if (!b64) {
        if (text) rememberText(text);
        return;
      }
      box.seq += 1;
      box.kind = "image";
      box.mime = mime;
      box.b64 = b64;
      box.text = extract(text);
    };
    const clip = navigator.clipboard;
    if (clip) {
      const origWrite = typeof clip.write === "function" ? clip.write.bind(clip) : null;
      const origWriteText = typeof clip.writeText === "function" ? clip.writeText.bind(clip) : null;
      if (origWrite) {
        clip.write = function (items) {
          const pending = (async () => {
            try {
              let imageBlob = null;
              let text = "";
              for (const item of Array.from(items || [])) {
                const types = item.types || [];
                for (const type of types) {
                  try {
                    const blob = await item.getType(type);
                    if (!blob) continue;
                    if (String(type).indexOf("image/") === 0) imageBlob = blob;
                    if (type === "text/plain" || type === "text/html") {
                      const t = await blob.text();
                      if (type === "text/plain" && t) text = t;
                      else if (!text) text = t;
                    }
                  } catch (e) {}
                }
              }
              if (imageBlob) await rememberImage(imageBlob, text);
              else if (text) rememberText(text);
            } catch (e) {}
          })();
          let written;
          try { written = Promise.resolve(origWrite(items)).catch(() => undefined); }
          catch (e) { written = Promise.resolve(undefined); }
          return Promise.all([pending, written]).then((out) => out[1]);
        };
        offs.push(() => { clip.write = origWrite; });
      }
      if (origWriteText) {
        clip.writeText = function (text) {
          try { rememberText(text); } catch (e) {}
          try { return Promise.resolve(origWriteText(text)).catch(() => undefined); }
          catch (e) { return Promise.resolve(undefined); }
        };
        offs.push(() => { clip.writeText = origWriteText; });
      }
    }
    const onCopy = () => {
      try {
        const sel = document.getSelection && String(document.getSelection() || "");
        if (sel) rememberText(sel);
      } catch (e) {}
    };
    document.addEventListener("copy", onCopy, true);
    offs.push(() => document.removeEventListener("copy", onCopy, true));
    const labelOf = (el) =>
      (((el.getAttribute && el.getAttribute("aria-label")) || "") + " " +
        (el.innerText || "") + " " +
        ((el.getAttribute && el.getAttribute("title")) || "") + " " +
        ((el.getAttribute && el.getAttribute("data-testid")) || "")).replace(/\\s+/g, " ").trim();
    const isMessageCopy = (label) => /copy-turn|copy-code|copy code|复制代码/i.test(label);
    const isLinkCopy = (label) => /copy link|copy url|share link|复制链接|拷贝链接|复制连接|拷贝连接|复制分享/i.test(label);
    const isImageCopy = (label) => {
      if (isMessageCopy(label) || isLinkCopy(label)) return false;
      if (/download|下载|edit|编辑/i.test(label) && !/copy|复制|拷贝/i.test(label)) return false;
      return /copy image|复制图片|拷贝图片/i.test(label) || /(^|\\s)(copy|复制|拷贝)(\\s|$)/i.test(label);
    };
    const insideCode = (btn) => !!(btn.closest && btn.closest("pre, textarea"));
    const imageNear = (btn) => {
      if (insideCode(btn)) return null;
      let el = btn;
      for (let i = 0; i < 5 && el; i++) {
        el = el.parentElement;
        if (!el || !el.querySelectorAll) return null;
        const imgs = Array.prototype.filter.call(el.querySelectorAll("img"), (img) => !(img.closest && img.closest("pre")));
        if (imgs.length > 1) return null;
        if (imgs.length === 1) {
          if ((el.innerText || "").length > 600) return null;
          return imgs[0];
        }
      }
      return null;
    };
    const blobFromImage = async (img) => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w >= 2 && h >= 2) {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (ctx) ctx.drawImage(img, 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          if (blob && blob.size) return blob;
        } catch (e) {}
      }
      const src = img.currentSrc || img.src || "";
      if (!src) return null;
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        if (blob && String(blob.type || "").indexOf("image/") === 0) return blob;
      } catch (e) {}
      return null;
    };
    const isBigImage = (img) => {
      const w = img.naturalWidth || 0;
      const h = img.naturalHeight || 0;
      if (w < 128 || h < 128) return false;
      const src = String(img.currentSrc || img.src || "");
      if (/avatar|favicon|emoji|\\/icon|logo/i.test(src)) return false;
      if (img.closest && img.closest("nav, header")) return false;
      return true;
    };
    const scanShare = () => {
      const bits = [];
      try {
        const fields = document.querySelectorAll("input, textarea");
        for (let i = 0; i < fields.length; i++) if (fields[i] && fields[i].value) bits.push(fields[i].value);
        const dialogs = document.querySelectorAll("[role='dialog'], [role='alertdialog']");
        for (let i = 0; i < dialogs.length; i++) bits.push(String(dialogs[i].innerText || "").slice(0, 4000));
      } catch (e) {}
      rememberText(bits.join("\\n"));
    };
    const scheduleScan = () => {
      const start = box.seq;
      let n = 0;
      const tick = () => {
        scanShare();
        n += 1;
        if (n < 8 && box.seq === start) setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    };
    const onClick = (ev) => {
      const t = ev && ev.target;
      const btn = t && t.closest && t.closest("button, [role='button']");
      if (!btn) return;
      const label = labelOf(btn);
      if (isLinkCopy(label)) scheduleScan();
      if (!isImageCopy(label)) return;
      const img = imageNear(btn);
      if (!img) return;
      blobFromImage(img).then((blob) => (blob ? rememberImage(blob, "") : null)).catch(() => {});
    };
    document.addEventListener("click", onClick, true);
    offs.push(() => document.removeEventListener("click", onClick, true));
    const origFetch = window.fetch ? window.fetch.bind(window) : null;
    if (origFetch) {
      window.fetch = function () {
        const args = arguments;
        let ret;
        try { ret = origFetch.apply(this, args); }
        catch (e) { return Promise.reject(e); }
        return Promise.resolve(ret).then((res) => {
          try {
            const raw = args[0] && args[0].url ? args[0].url : args[0];
            const url = String(raw || "");
            if (res && res.ok && /share/i.test(url) && typeof res.clone === "function") {
              res.clone().json().then((data) => {
                const found = [];
                const walk = (v, depth) => {
                  if (depth > 4 || v == null) return;
                  if (typeof v === "string") found.push(v);
                  else if (typeof v === "object") {
                    const keys = Object.keys(v);
                    for (let i = 0; i < keys.length; i++) walk(v[keys[i]], depth + 1);
                  }
                };
                walk(data, 0);
                rememberText(found.join("\\n"));
              }).catch(() => {});
            }
          } catch (e) {}
          return res;
        });
      };
      offs.push(() => { window.fetch = origFetch; });
    }
    window.__gpcPickImage = async () => {
      const imgs = [];
      try {
        const all = document.querySelectorAll("img");
        for (let i = 0; i < all.length; i++) if (isBigImage(all[i])) imgs.push(all[i]);
      } catch (e) {}
      const img = imgs[imgs.length - 1];
      if (!img) return { ok: false, error: "对话里还没有可保存的图片" };
      const blob = await blobFromImage(img);
      if (!blob) return { ok: false, error: "没能取出图片" };
      let mime = normMime(blob.type) || "image/png";
      const b64 = await blobToB64(blob);
      if (!b64) return { ok: false, error: "图片太大，请在画面里点下载后再试" };
      let text = box.kind === "text" ? box.text : "";
      if (!text) {
        scanShare();
        text = box.text || "";
      }
      await rememberImage(blob, text);
      return { ok: true, mime, b64, text: extract(text) || "" };
    };
    window.__gpcClipUnhook = () => {
      for (let i = 0; i < offs.length; i++) {
        try { offs[i](); } catch (e) {}
      }
      offs.length = 0;
      try { window.fetch = origFetch || window.fetch; } catch (e) {}
      window.__gpcClipVer = 0;
    };
    window.__gpcClipVer = VER;
  })()`;
}

export async function installClipCapture(send, sessionId) {
  if (typeof send !== "function") return false;
  const source = clipCaptureSource();
  try {
    await send("Page.enable", {}, sessionId);
  } catch {
    /* Page domain may already be enabled */
  }
  try {
    await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  } catch {
    /* current document is still evaluated below */
  }
  await send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true }, sessionId);
  return true;
}

export async function readCapturedClip({ evaluate, install, seenSeq = 0 } = {}) {
  if (typeof evaluate !== "function") return null;
  let raw = null;
  try {
    raw = await evaluate(clipCaptureReadExpression(seenSeq));
  } catch {
    raw = { missing: true };
  }
  if (raw?.missing && typeof install === "function") {
    try {
      await install();
      raw = await evaluate(clipCaptureReadExpression(seenSeq));
    } catch {
      return null;
    }
  }
  if (raw?.unchanged) return { unchanged: true, seq: Number(raw.seq) || seenSeq || 0 };
  return clipPayloadFromCapture(raw);
}

export async function pickDeskImage({ evaluate, install } = {}) {
  if (typeof evaluate !== "function") return { ok: false, status: 502, error: "画面还没准备好" };
  const ensure = async () => {
    if (typeof install !== "function") return;
    let ver = 0;
    try {
      ver = await evaluate("window.__gpcClipVer||0");
    } catch {
      ver = 0;
    }
    if (ver !== CLIP_HOOK_VER) await install();
  };
  try {
    await ensure();
  } catch {
    return { ok: false, status: 502, error: "画面还没准备好" };
  }
  let raw;
  try {
    raw = await evaluate(pickGeneratedImageExpression());
  } catch {
    return { ok: false, status: 502, error: "没能取出图片" };
  }
  if (!raw?.ok) return { ok: false, status: 404, error: raw?.error || "对话里还没有可保存的图片" };
  const payload = clipPayloadFromCapture({
    seq: Date.now(),
    kind: "image",
    mime: raw.mime,
    b64: raw.b64,
    text: raw.text,
  });
  if (!payload || payload.kind !== "image") return { ok: false, status: 404, error: "没能取出图片" };
  return { ok: true, payload };
}
