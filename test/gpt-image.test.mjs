import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packUstar } from "../lib/desk-files.mjs";
import {
  attachmentDisposition,
  classifyImageUrl,
  decodeCapturedImage,
  filenameForImage,
  gptImageCaptureExpression,
  gptImageHookExpression,
  installGptImageHook,
  sniffImage,
} from "../lib/gpt-image.mjs";
import {
  armBrowserImageDownloads,
  assertDownloadPath,
  containerDownloadPath,
  createImageDownloadHub,
  downloadDirSetupCommand,
  imageBytesReady,
  mightBeImageDownload,
  readContainerDownload,
} from "../lib/image-downloads.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function jpeg(complete = true) {
  const buf = Buffer.alloc(24, 0);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  if (complete) {
    buf[buf.length - 2] = 0xff;
    buf[buf.length - 1] = 0xd9;
  }
  return buf;
}

function webp(complete = true) {
  const buf = Buffer.alloc(complete ? 24 : 20);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(complete ? 16 : 40, 4);
  buf.write("WEBP", 8);
  return buf;
}

function gif(complete = true) {
  const buf = Buffer.alloc(16, 0);
  buf.write("GIF89a", 0);
  if (complete) buf[buf.length - 1] = 0x3b;
  return buf;
}

function responseFrom(bytes, mime) {
  const copy = Buffer.from(bytes);
  return {
    ok: true,
    blob: async () => ({
      type: mime,
      arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    }),
  };
}

function el(tag, attrs = {}, extra = {}) {
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    attrs: { ...attrs },
    children: extra.children || [],
    parentElement: null,
    shadowRoot: extra.shadowRoot || null,
    innerText: extra.innerText || "",
    textContent: extra.textContent || extra.innerText || "",
    src: extra.src || "",
    currentSrc: extra.currentSrc || extra.src || "",
    naturalWidth: extra.naturalWidth || 0,
    naturalHeight: extra.naturalHeight || 0,
    complete: extra.complete !== false,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const child of n.children || []) {
          if (sel === "img" && child.tagName === "IMG") out.push(child);
          if (sel === "a[download]" && child.tagName === "A" && child.getAttribute("download") != null) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
  };
  for (const child of node.children) child.parentElement = node;
  return node;
}

async function runCapture({ images = [], dialog = [], fetchImpl, canvas }) {
  const document = {
    querySelectorAll(sel) {
      if (sel === "img") return images;
      if (String(sel).includes("dialog")) return dialog;
      return [];
    },
    createElement() {
      return canvas || {};
    },
  };
  const sandbox = {
    document,
    location: { href: "https://chatgpt.com/" },
    fetch: fetchImpl,
    btoa: globalThis.btoa,
    URL: globalThis.URL,
    setTimeout,
  };
  return vm.runInNewContext(gptImageCaptureExpression(), sandbox);
}

describe("generated image bytes", () => {
  it("classifies blob, data, and ChatGPT CDN urls, and ignores other pages", () => {
    assert.equal(classifyImageUrl("blob:https://chatgpt.com/8d2c"), "blob");
    assert.equal(classifyImageUrl("data:image/png;base64,aaaa"), "data");
    assert.equal(classifyImageUrl("data:text/html,hi"), "");
    assert.equal(classifyImageUrl("https://files.oaiusercontent.com/file-abc?se=1"), "cdn");
    assert.equal(classifyImageUrl("https://files.oaiusercontent.com.evil.com/a.png"), "");
    assert.equal(classifyImageUrl("http://files.oaiusercontent.com/a.png"), "");
    assert.equal(classifyImageUrl("https://chatgpt.com/backend-api/estuary/content?id=file-1"), "cdn");
    assert.equal(classifyImageUrl("https://chatgpt.com/backend-api/files/file_1/download"), "cdn");
    assert.equal(classifyImageUrl("https://chatgpt.com/g/g-p-abc/project"), "");
    assert.equal(classifyImageUrl("https://cdn.oaistatic.com/assets/logo.png"), "");
    assert.equal(classifyImageUrl("https://example.com/cat.png"), "");
  });

  it("sniffs complete images and rejects truncated or non-image bytes", () => {
    assert.equal(sniffImage(PNG).mime, "image/png");
    assert.equal(sniffImage(PNG).incomplete, false);
    assert.equal(sniffImage(PNG.subarray(0, 20)).incomplete, true);
    assert.equal(sniffImage(jpeg(true)).mime, "image/jpeg");
    assert.equal(sniffImage(jpeg(false)).incomplete, true);
    assert.equal(sniffImage(webp(true)).mime, "image/webp");
    assert.equal(sniffImage(webp(false)).incomplete, true);
    assert.equal(sniffImage(gif(true)).mime, "image/gif");
    assert.equal(sniffImage(gif(false)).incomplete, true);
    assert.equal(sniffImage(Buffer.from("<!DOCTYPE html><html></html>")), null);
    assert.equal(sniffImage(Buffer.alloc(8)), null);
  });

  it("names files from the sniffed type and keeps a downloadable Content-Disposition", () => {
    assert.equal(filenameForImage("", "image/png"), "ChatGPT-image.png");
    assert.equal(filenameForImage("download", "image/webp"), "ChatGPT-image.webp");
    assert.equal(filenameForImage("shot.jpg", "image/png"), "shot.png");
    assert.equal(filenameForImage("../../图片.png.crdownload", "image/png"), "图片.png");
    assert.equal(filenameForImage("C:\\Users\\a\\DALL·E.png", "image/png"), "DALL_E.png");
    const header = attachmentDisposition("图片.png");
    assert.match(header, /filename=".*\.png"/);
    assert.match(header, /filename\*=UTF-8''/);
    assert.match(header, /%E5%9B%BE%E7%89%87/);
  });

  it("decodes a page payload only when the bytes are a finished image", () => {
    const good = decodeCapturedImage({ ok: true, source: "blob", filename: "a.webp", base64: PNG.toString("base64") });
    assert.equal(good.ok, true);
    assert.equal(good.mime, "image/png");
    assert.equal(good.filename, "a.png");
    assert.equal(good.source, "blob");
    assert.deepEqual(good.bytes, PNG);

    const html = decodeCapturedImage({ ok: true, source: "cdn", mime: "image/png", base64: Buffer.from("<html>").toString("base64") });
    assert.equal(html.ok, false);
    assert.equal(html.status, 415);

    const partial = decodeCapturedImage({ ok: true, source: "cdn", base64: jpeg(false).toString("base64") });
    assert.equal(partial.status, 409);

    const hostile = decodeCapturedImage({ ok: false, error: "<img src=x onerror=alert(1)>" });
    assert.equal(hostile.error, "无法读取这张生成图");
    assert.equal(decodeCapturedImage({ ok: false, error: "当前对话里还没有可下载的生成图" }).status, 404);
    assert.equal(decodeCapturedImage({ ok: false, error: "图片太大" }).status, 413);
  });
});

describe("page capture of blob and CDN images", () => {
  it("reads the latest blob image and skips logos and foreign urls", async () => {
    const logo = el("img", { alt: "logo" }, { src: "https://cdn.oaistatic.com/logo.png", naturalWidth: 256, naturalHeight: 256 });
    const foreign = el("img", {}, { src: "https://example.com/cat.png", naturalWidth: 1024, naturalHeight: 1024 });
    const generated = el("img", { alt: "Generated image" }, { src: "blob:https://chatgpt.com/pic", naturalWidth: 1024, naturalHeight: 1024 });
    const seen = [];
    const result = await runCapture({
      images: [logo, foreign, generated],
      fetchImpl: async (url) => {
        seen.push(url);
        return responseFrom(PNG, "image/png");
      },
    });
    assert.deepEqual(seen, ["blob:https://chatgpt.com/pic"]);
    const decoded = decodeCapturedImage(result);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.source, "blob");
    assert.deepEqual(decoded.bytes, PNG);
  });

  it("fetches an oaiusercontent url from inside the page", async () => {
    const img = el("img", {}, {
      src: "https://files.oaiusercontent.com/file-abc?se=1",
      naturalWidth: 512,
      naturalHeight: 512,
    });
    const result = await runCapture({
      images: [img],
      fetchImpl: async (url) => {
        assert.match(url, /oaiusercontent\.com/);
        return responseFrom(jpeg(true), "image/jpeg");
      },
    });
    const decoded = decodeCapturedImage(result);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.source, "cdn");
    assert.equal(decoded.mime, "image/jpeg");
    assert.equal(decoded.filename, "ChatGPT-image.jpg");
  });

  it("uses the image element when the CDN fetch is blocked", async () => {
    const img = el("img", {}, {
      src: "https://chatgpt.com/backend-api/files/file_1/download",
      naturalWidth: 300,
      naturalHeight: 300,
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext() {
        return { drawImage() {} };
      },
      toBlob(cb) {
        const copy = Buffer.from(PNG);
        cb({
          arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
        });
      },
    };
    const result = await runCapture({
      images: [img],
      canvas,
      fetchImpl: async () => {
        throw new Error("cors");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.source, "canvas");
    assert.equal(decodeCapturedImage(result).mime, "image/png");
  });

  it("reports a missing image and a still-loading image", async () => {
    const none = await runCapture({ images: [], fetchImpl: async () => responseFrom(PNG, "image/png") });
    assert.equal(none.error, "当前对话里还没有可下载的生成图");
    const loading = el("img", {}, { src: "blob:https://chatgpt.com/soon", naturalWidth: 0, complete: false });
    const wait = await runCapture({ images: [loading], fetchImpl: async () => responseFrom(PNG, "image/png") });
    assert.equal(wait.error, "图片还在加载，稍后再试");
  });

  it("installs a click hook that saves the nearby image and ignores other buttons", async () => {
    const img = el("img", {}, { src: "blob:https://chatgpt.com/near", naturalWidth: 800, naturalHeight: 800 });
    const download = el("button", { "aria-label": "下载" });
    const share = el("button", { "aria-label": "Share" });
    el("article", {}, { children: [img, download, share] });
    const far = el("button", { "aria-label": "Download" });
    const calls = [];
    const jobs = [];
    const document = {
      querySelectorAll(sel) {
        if (sel === "img") return [img];
        return [];
      },
      addEventListener(_type, fn) {
        calls.push(fn);
      },
      createElement() {
        return {};
      },
    };
    const sandbox = {
      document,
      location: { href: "https://chatgpt.com/" },
      fetch: async () => responseFrom(PNG, "image/png"),
      btoa: globalThis.btoa,
      URL: globalThis.URL,
      setTimeout(fn) {
        jobs.push(fn);
        return 1;
      },
      JSON,
    };
    sandbox.window = sandbox;
    sandbox.gpcDeliverImage = (payload) => calls.push(payload);
    const installed = vm.runInNewContext(gptImageHookExpression(), sandbox);
    assert.equal(installed.installed, true);
    calls[0]({ target: share });
    assert.equal(jobs.length, 0);
    calls[0]({ target: far });
    assert.equal(jobs.length, 0);
    calls[0]({ target: download });
    assert.equal(jobs.length, 1);
    jobs[0]();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sent = calls.find((item) => typeof item === "string");
    const decoded = decodeCapturedImage(JSON.parse(sent));
    assert.equal(decoded.ok, true);
    assert.equal(decoded.source, "blob");
  });
});

describe("Chromium image downloads reach the member browser", () => {
  it("keeps files inside the download directory and ignores non-images", () => {
    assert.equal(mightBeImageDownload("ChatGPT Image.png"), true);
    assert.equal(mightBeImageDownload("picture.webp.crdownload"), true);
    assert.equal(mightBeImageDownload("notes.pdf"), false);
    assert.equal(mightBeImageDownload(""), true);
    const guid = "a1b2c3d4e5f67890abcd1234ef567890";
    assert.equal(containerDownloadPath(guid, "图片.png", "guid"), `/config/gpc-downloads/${guid}`);
    assert.equal(assertDownloadPath("/config/gpc-downloads/../chromium/Cookies"), "");
    assert.match(downloadDirSetupCommand().join(" "), /gpc-downloads/);
    assert.match(downloadDirSetupCommand().join(" "), /PromptForDownload/);
  });

  it("arms allowAndName, falls back to allow, and emits only a finished image", async () => {
    const calls = [];
    const listeners = [];
    const armed = await armBrowserImageDownloads({
      send: async (method, params) => {
        calls.push({ method, params });
        if (params?.behavior === "allowAndName") throw new Error("old chromium");
      },
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      onBegin: (meta) => calls.push({ begin: meta }),
      onFile: (meta) => calls.push({ file: meta }),
    });
    assert.equal(armed.mode, "name");
    const guid = "a1b2c3d4e5f67890abcd1234ef567890";
    listeners[0]({ method: "Browser.downloadWillBegin", params: { guid, suggestedFilename: "notes.pdf" } });
    listeners[0]({ method: "Browser.downloadProgress", params: { guid, state: "completed", receivedBytes: 8 } });
    listeners[0]({ method: "Browser.downloadWillBegin", params: { guid, suggestedFilename: "../图片.png" } });
    listeners[0]({ method: "Browser.downloadProgress", params: { guid, state: "inProgress", receivedBytes: 4 } });
    listeners[0]({ method: "Browser.downloadProgress", params: { guid, state: "completed", receivedBytes: 8 } });
    const saved = calls.find((c) => c.file);
    assert.equal(saved.file.filename, "../图片.png");
    assert.equal(saved.file.containerPath, "/config/gpc-downloads/图片.png");
    assert.equal(calls.filter((c) => c.file).length, 1);
  });

  it("attributes a finished image to the recent member and drops a duplicate click capture", async () => {
    let t = 1_000;
    const hub = createImageDownloadHub({ now: () => t });
    hub.noteActor("a", "ada");
    const item = hub.completeBytes("a", { bytes: PNG, filename: "图片.png" }, { occupants: ["ada", "bea"], via: "chromium" });
    assert.equal(item.name, "图片.png");
    const ada = hub.listFor("a", "ada", { consumeAuto: true });
    assert.equal(ada[0].auto, true);
    assert.equal(hub.listFor("a", "ada")[0].auto, false);
    assert.equal(hub.listFor("a", "bea")[0].auto, false);
    assert.equal(hub.completeBytes("a", { bytes: PNG, filename: "again.png" }), null);

    hub.noteBrowserSave("a", { filename: "other.png", state: "inProgress" });
    assert.equal(hub.acceptClickCapture("a", PNG.length, "other.png"), false);
    t += 10_000;
    assert.equal(hub.acceptClickCapture("a", jpeg(true).length, "fresh.png"), true);

    let woke = false;
    const pending = hub.wait("a", "ada", 5000).then(() => {
      woke = true;
    });
    hub.completeBytes("a", { bytes: jpeg(true), filename: "fresh.png" }, { occupants: ["ada"], via: "click" });
    await pending;
    assert.equal(woke, true);
  });

  it("retries a short read and refuses a truncated or oversized image", async () => {
    let n = 0;
    const docker = {
      async getArchive() {
        n += 1;
        if (n === 1) {
          const err = new Error("missing");
          err.status = 404;
          throw err;
        }
        return packUstar([{ name: "pic.png", bytes: PNG }]);
      },
    };
    const got = await readContainerDownload(docker, "gpt-pro-cloud-a", "/config/gpc-downloads/pic.png", {
      sleep: async () => {},
      accept: imageBytesReady,
    });
    assert.deepEqual(got, PNG);
    await assert.rejects(
      () =>
        readContainerDownload(
          {
            async getArchive() {
              return packUstar([{ name: "part.jpg", bytes: jpeg(false) }]);
            },
          },
          "c",
          "/config/gpc-downloads/part.jpg",
          { attempts: 2, sleep: async () => {}, accept: imageBytesReady },
        ),
      (err) => err.status === 409,
    );
    await assert.rejects(
      () =>
        readContainerDownload(
          {
            async getArchive() {
              return packUstar([{ name: "big.png", bytes: Buffer.alloc(32) }]);
            },
          },
          "c",
          "/config/gpc-downloads/big.png",
          { maxBytes: 8, sleep: async () => {} },
        ),
      (err) => err.status === 413,
    );
  });

  it("installs the page hook with a binding", async () => {
    const calls = [];
    await installGptImageHook(async (method, params) => {
      calls.push({ method, params });
      return {};
    }, "session-1");
    assert.equal(calls[0].method, "Runtime.enable");
    assert.equal(calls.some((c) => c.method === "Runtime.addBinding" && c.params.name === "gpcDeliverImage"), true);
    assert.equal(calls.some((c) => c.method === "Runtime.evaluate" && /__gpcImageHook/.test(c.params.expression)), true);
  });
});

describe("gpt image wiring", () => {
  it("exposes the top-bar download and does not require the multi-user CDP switch", () => {
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const gw = readFileSync(resolve(root, "gateway/server.mjs"), "utf8");
    const init = readFileSync(resolve(root, "docker/update-autostart.sh"), "utf8");
    const zh = readFileSync(resolve(root, "README.zh-CN.md"), "utf8");
    assert.match(ui, /id="download-image"/);
    assert.match(ui, /下载图片/);
    assert.match(ui, /\/api\/desks\/\$\{state\.deskId\}\/gpt-image/);
    assert.match(ui, /saveBlobLocally/);
    assert.match(ui, /image-downloads/);
    assert.match(gw, /captureDeskGptImage/);
    assert.match(gw, /gptImageCaptureExpression/);
    assert.match(gw, /ensureDeskImageBridge/);
    assert.match(gw, /content-disposition/);
    assert.doesNotMatch(gw, /gpt-image[\s\S]{0,400}deskCdpOn/);
    assert.match(init, /gpc-downloads/);
    assert.match(init, /DownloadDirectory/);
    assert.match(zh, /下载图片/);
    assert.match(zh, /blob:/);
    assert.match(zh, /oaiusercontent/);
  });
});

function cookieOf(res) {
  const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return lines
    .map((line) => String(line).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

describe("gpt image API without a desk", () => {
  let child;
  let base;
  let cookie;

  before(async () => {
    const dir = mkdtempSync(join(tmpdir(), "gpc-img-"));
    const port = 19000 + Math.floor(Math.random() * 2000);
    child = spawn(process.execPath, [join(root, "gateway/server.mjs")], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        AUTH_USER: "admin",
        AUTH_PASSWORD: "admin-secret",
        USERS_FILE: join(dir, "users.json"),
        INSTANCES: "a",
        DOCKER_SOCKET: join(dir, "no-docker.sock"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gateway did not start")), 15000);
      const onData = (chunk) => {
        if (/gateway on/.test(chunk.toString())) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
    });
    base = `http://127.0.0.1:${port}`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin-secret" }),
    });
    assert.equal(login.status, 200);
    cookie = cookieOf(login);
  });

  after(() => {
    if (child && !child.killed) child.kill("SIGTERM");
  });

  it("asks the member to retry when the desk page is not reachable", async () => {
    const anon = await fetch(`${base}/api/desks/a/gpt-image`, { method: "POST" });
    assert.equal(anon.status, 401);
    const res = await fetch(`${base}/api/desks/a/gpt-image`, { method: "POST", headers: { cookie } });
    const data = await res.json();
    assert.equal(res.status, 502);
    assert.match(data.error, /桌面还没准备好|还没打开 ChatGPT|无法读取/);
    const list = await fetch(`${base}/api/desks/a/image-downloads?wait=0`, { headers: { cookie } });
    const files = await list.json();
    assert.equal(list.status, 200);
    assert.deepEqual(files.files, []);
  });
});
