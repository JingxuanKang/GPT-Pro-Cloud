/**
 * Pull a ChatGPT-generated image out of the desk page and hand the bytes to
 * the member's browser.
 *
 * GPT Image / DALL·E results usually live as a blob: URL or an
 * oaiusercontent / chatgpt.com file URL inside the page. ChatGPT's own
 * Save / Download control often never calls Chromium's download manager, so
 * waiting on Browser.downloadProgress is not enough. This module reads the
 * image from inside the page (blob, data, or CDN fetch; canvas if the
 * element is readable) and checks the bytes before they leave the gateway.
 */
import { randomBytes } from "node:crypto";

export const GPT_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export const GPT_IMAGE_MIN_PX = 128;
export const GPT_IMAGE_BINDING = "gpcDeliverImage";
export const GPT_IMAGE_CLICK_WAIT_MS = 900;

const PAGE_ERRORS = new Set([
  "当前对话里还没有可下载的生成图",
  "图片还在加载，稍后再试",
  "图片不完整",
  "图片太大",
  "无法读取这张生成图",
]);

const EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function newImageId() {
  return randomBytes(16).toString("hex");
}

export function cleanPageError(error) {
  const text = String(error || "");
  return PAGE_ERRORS.has(text) ? text : "无法读取这张生成图";
}

/** blob, data-image, or a ChatGPT / OpenAI file host. Other https URLs are not images we save. */
export function classifyImageUrl(url) {
  const raw = String(url || "").trim();
  if (/^blob:/i.test(raw)) return "blob";
  if (/^data:image\/(png|jpe?g|webp|gif)/i.test(raw)) return "data";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:") return "";
  const host = parsed.hostname.toLowerCase();
  const where = `${parsed.pathname}${parsed.search}`;
  if (/(^|\.)oaiusercontent\.com$/.test(host)) return "cdn";
  if (host === "chatgpt.com" || host === "chat.openai.com" || host.endsWith(".chatgpt.com")) {
    if (/\/backend-api\/|\/backend\/|estuary|\/files\/|\/file[-_]/i.test(where)) return "cdn";
  }
  if (host === "openai.com" || host.endsWith(".openai.com")) {
    if (/estuary|\/files\/|\/file[-_]|\/content/i.test(where)) return "cdn";
  }
  return "";
}

function looksLike(bytes, ascii, offset) {
  return bytes.toString("ascii", offset, offset + ascii.length) === ascii;
}

/** png / jpeg / webp / gif, or the same type with a missing trailer. */
export function sniffImage(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (b.length < 16) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const tail = b.subarray(Math.max(0, b.length - 24));
    const complete = tail.includes(Buffer.from("IEND"));
    return { mime: "image/png", ext: "png", incomplete: !complete };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let complete = false;
    const start = Math.max(2, b.length - 16);
    for (let i = b.length - 2; i >= start; i--) {
      if (b[i] === 0xff && b[i + 1] === 0xd9) {
        complete = true;
        break;
      }
    }
    return { mime: "image/jpeg", ext: "jpg", incomplete: !complete };
  }
  if (looksLike(b, "RIFF", 0) && looksLike(b, "WEBP", 8)) {
    const size = b.readUInt32LE(4);
    const complete = Number.isFinite(size) && b.length >= size + 8;
    return { mime: "image/webp", ext: "webp", incomplete: !complete };
  }
  const sig = b.toString("ascii", 0, 6);
  if (sig === "GIF87a" || sig === "GIF89a") {
    return { mime: "image/gif", ext: "gif", incomplete: b[b.length - 1] !== 0x3b };
  }
  return null;
}

export function safeImageFilename(name) {
  const base = String(name || "ChatGPT-image")
    .split(/[/\\]/)
    .pop()
    .replace(/^\.+/, "");
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff ()-]+/g, "_").replace(/_+/g, "_").slice(0, 120);
  return cleaned || "ChatGPT-image";
}

export function filenameForImage(suggested, mime) {
  const ext = EXT[mime] || "png";
  let base = safeImageFilename(suggested);
  base = base.replace(/\.crdownload$/i, "");
  if (!base || /^(download|image|chatgpt-image)$/i.test(base)) return `ChatGPT-image.${ext}`;
  if (!new RegExp(`\\.${ext}$`, "i").test(base)) {
    base = base.replace(/\.(png|jpe?g|webp|gif)$/i, "");
    return `${base}.${ext}`;
  }
  return base;
}

export function attachmentDisposition(name) {
  const base = safeImageFilename(name);
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "ChatGPT-image.png";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export function decodeCapturedImage(payload, { maxBytes = GPT_IMAGE_MAX_BYTES } = {}) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, status: 502, error: "无法读取这张生成图" };
  }
  if (!payload.ok) {
    const error = cleanPageError(payload.error);
    const status =
      error === "当前对话里还没有可下载的生成图" || error === "图片还在加载，稍后再试"
        ? 404
        : error === "图片太大"
          ? 413
          : error === "图片不完整"
            ? 409
            : 502;
    return { ok: false, status, error };
  }
  const bytes = Buffer.from(String(payload.base64 || ""), "base64");
  if (!bytes.length) return { ok: false, status: 404, error: "图片不完整" };
  if (bytes.length > maxBytes) return { ok: false, status: 413, error: "图片太大" };
  const info = sniffImage(bytes);
  if (!info) return { ok: false, status: 415, error: "不是可保存的图片" };
  if (info.incomplete) return { ok: false, status: 409, error: "图片不完整" };
  const source = ["blob", "data", "cdn", "canvas"].includes(payload.source) ? payload.source : "page";
  return {
    ok: true,
    bytes,
    mime: info.mime,
    filename: filenameForImage(payload.filename, info.mime),
    source,
  };
}

function pageSource() {
  return `
    const MAX = ${GPT_IMAGE_MAX_BYTES};
    const MIN = ${GPT_IMAGE_MIN_PX};
    function classify(url) {
      const raw = String(url || "").trim();
      if (/^blob:/i.test(raw)) return "blob";
      if (/^data:image\\/(png|jpe?g|webp|gif)/i.test(raw)) return "data";
      var parsed;
      try { parsed = new URL(raw, location.href); } catch (e) { return ""; }
      if (parsed.protocol !== "https:") return "";
      var host = parsed.hostname.toLowerCase();
      var where = parsed.pathname + parsed.search;
      if (/(^|\\.)oaiusercontent\\.com$/.test(host)) return "cdn";
      if (host === "chatgpt.com" || host === "chat.openai.com" || /\\.chatgpt\\.com$/.test(host)) {
        if (/\\/backend-api\\/|\\/backend\\/|estuary|\\/files\\/|\\/file[-_]/i.test(where)) return "cdn";
      }
      if (host === "openai.com" || /\\.openai\\.com$/.test(host)) {
        if (/estuary|\\/files\\/|\\/file[-_]|\\/content/i.test(where)) return "cdn";
      }
      return "";
    }
    function clean(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }
    function inChrome(el) {
      var node = el;
      while (node) {
        var tag = String(node.tagName || "").toLowerCase();
        var role = node.getAttribute ? (node.getAttribute("role") || "") : "";
        if (tag === "nav" || tag === "header" || role === "banner") return true;
        node = node.parentElement;
      }
      return false;
    }
    function describe(img) {
      if (!img) return null;
      var src = String(img.currentSrc || img.src || "");
      var kind = classify(src);
      if (!kind) return null;
      var width = img.naturalWidth || 0;
      var height = img.naturalHeight || 0;
      if (width < MIN || height < MIN) return null;
      if (inChrome(img)) return null;
      var alt = img.getAttribute ? (img.getAttribute("alt") || "") : "";
      if (/avatar|favicon|logo|emoji/i.test(alt + " " + src)) return null;
      return { img: img, src: src, kind: kind, width: width, height: height };
    }
    function collectImgs() {
      var out = [];
      var seen = new Set();
      function add(img) {
        if (!img || seen.has(img)) return;
        seen.add(img);
        out.push(img);
      }
      var rootImgs = document.querySelectorAll ? document.querySelectorAll("img") : [];
      for (var i = 0; i < rootImgs.length; i++) add(rootImgs[i]);
      var hosts = document.querySelectorAll ? document.querySelectorAll("div, article, section") : [];
      var n = 0;
      for (var h = 0; h < hosts.length; h++) {
        if (++n > 500) break;
        var root = hosts[h].shadowRoot;
        if (!root || !root.querySelectorAll) continue;
        var inner = root.querySelectorAll("img");
        for (var j = 0; j < inner.length; j++) add(inner[j]);
      }
      return out;
    }
    function dialogCandidate() {
      if (!document.querySelectorAll) return null;
      var nodes = document.querySelectorAll("[role='dialog'] img, [role='alertdialog'] img");
      for (var i = 0; i < nodes.length; i++) {
        var info = describe(nodes[i]);
        if (info) return info;
      }
      return null;
    }
    function nearestCandidate(el) {
      var node = el;
      for (var depth = 0; depth < 8 && node; depth++) {
        var imgs = node.querySelectorAll ? node.querySelectorAll("img") : [];
        for (var i = 0; i < imgs.length; i++) {
          if (describe(imgs[i])) return imgs[i];
        }
        if (String(node.tagName || "").toLowerCase() === "img" && describe(node)) return node;
        node = node.parentElement;
      }
      return null;
    }
    function nearbyName(img) {
      var node = img;
      for (var depth = 0; depth < 6 && node; depth++) {
        var links = node.querySelectorAll ? node.querySelectorAll("a[download]") : [];
        for (var i = 0; i < links.length; i++) {
          var name = links[i].getAttribute && links[i].getAttribute("download");
          if (name) return String(name);
        }
        node = node.parentElement;
      }
      return "";
    }
    function toB64(bytes) {
      var chunk = 0x8000;
      var bin = "";
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    }
    async function readUrl(url) {
      var res = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!res || !res.ok) throw new Error("fetch");
      var mime = "";
      if (typeof res.blob === "function") {
        var blob = await res.blob();
        mime = blob.type || "";
        var buf = await blob.arrayBuffer();
        return { bytes: new Uint8Array(buf), mime: mime };
      }
      var raw = await res.arrayBuffer();
      return { bytes: new Uint8Array(raw), mime: mime };
    }
    async function readCanvas(img) {
      if (!img.complete || !img.naturalWidth) throw new Error("loading");
      var canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      var ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      var blob = await new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("taint")); }, "image/png");
      });
      var buf = await blob.arrayBuffer();
      return { bytes: new Uint8Array(buf), mime: "image/png" };
    }
    async function captureElement(img) {
      var info = describe(img);
      if (!info) {
        if (img && (!img.complete || !(img.naturalWidth > 0)) && classify(String(img.currentSrc || img.src || ""))) {
          return { ok: false, error: "图片还在加载，稍后再试" };
        }
        return { ok: false, error: "当前对话里还没有可下载的生成图" };
      }
      var read = null;
      var source = info.kind;
      try {
        read = await readUrl(info.src);
      } catch (e) {
        try {
          read = await readCanvas(img);
          source = "canvas";
        } catch (e2) {
          return { ok: false, error: "无法读取这张生成图" };
        }
      }
      if (!read || !read.bytes || read.bytes.length < 24) return { ok: false, error: "图片不完整" };
      if (read.bytes.length > MAX) return { ok: false, error: "图片太大" };
      return {
        ok: true,
        source: source,
        mime: read.mime || "",
        filename: nearbyName(img) || "",
        width: info.width,
        height: info.height,
        base64: toB64(read.bytes)
      };
    }
    async function captureLatest() {
      var imgs = collectImgs();
      var loading = false;
      var ready = [];
      for (var i = 0; i < imgs.length; i++) {
        var src = String(imgs[i].currentSrc || imgs[i].src || "");
        if (!classify(src)) continue;
        if (!imgs[i].complete || !(imgs[i].naturalWidth > 0)) { loading = true; continue; }
        var info = describe(imgs[i]);
        if (info) ready.push(info);
      }
      var dialog = dialogCandidate();
      var picked = dialog || (ready.length ? ready[ready.length - 1] : null);
      if (!picked) {
        return { ok: false, error: loading ? "图片还在加载，稍后再试" : "当前对话里还没有可下载的生成图" };
      }
      return captureElement(picked.img);
    }
    function controlOf(node) {
      var el = node;
      while (el) {
        var tag = String(el.tagName || "").toLowerCase();
        var role = el.getAttribute ? (el.getAttribute("role") || "") : "";
        if (tag === "a" || tag === "button" || role === "button") return el;
        el = el.parentElement;
      }
      return null;
    }
    function isDownloadControl(el) {
      if (!el || inChrome(el)) return false;
      var aria = clean(el.getAttribute && el.getAttribute("aria-label"));
      var title = clean(el.getAttribute && el.getAttribute("title"));
      var testid = clean(el.getAttribute && el.getAttribute("data-testid"));
      var tag = String(el.tagName || "").toLowerCase();
      if (tag === "a" && el.getAttribute && el.getAttribute("download") != null) return true;
      if (/download|save[-_ ]?image/i.test(testid)) return true;
      if (/^(download|download image|download this image|save image|save this image)$/i.test(aria)) return true;
      if (/^(download|download image)$/i.test(title)) return true;
      if (/^(下载|下载图片|下载此图片|下载图像|保存图片|保存图像)$/.test(aria)) return true;
      var text = clean(el.innerText || el.textContent || "");
      if (text.length <= 12 && /^(下载|下载图片|Download|Download image)$/i.test(text)) return true;
      return false;
    }
  `;
}

export function gptImageCaptureExpression() {
  return `(() => { ${pageSource()} return captureLatest(); })()`;
}

export function gptImageHookExpression() {
  return `(() => {
    ${pageSource()}
    if (window.__gpcImageHook) return { ok: true, installed: true };
    window.__gpcImageHook = true;
    document.addEventListener("click", function (event) {
      var el = controlOf(event && event.target);
      if (!el || !isDownloadControl(el)) return;
      var img = nearestCandidate(el);
      if (!img) return;
      setTimeout(function () {
        captureElement(img).then(function (payload) {
          if (!payload || !payload.ok) return;
          payload.via = "click";
          var send = window.${GPT_IMAGE_BINDING};
          if (typeof send === "function") send(JSON.stringify(payload));
        }).catch(function () {});
      }, ${GPT_IMAGE_CLICK_WAIT_MS});
    }, true);
    return { ok: true, installed: true };
  })()`;
}

export async function installGptImageHook(send, sessionId) {
  if (typeof send !== "function") return { ok: false };
  await send("Runtime.enable", {}, sessionId);
  try {
    await send("Page.enable", {}, sessionId);
  } catch {
    /* click hook still installs on the current document */
  }
  try {
    await send("Runtime.addBinding", { name: GPT_IMAGE_BINDING }, sessionId);
  } catch {
    /* already bound on this session */
  }
  const source = gptImageHookExpression();
  try {
    await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  } catch {
    /* reload hook is best-effort */
  }
  await send("Runtime.evaluate", { expression: source, awaitPromise: true, returnByValue: true }, sessionId);
  return { ok: true };
}
