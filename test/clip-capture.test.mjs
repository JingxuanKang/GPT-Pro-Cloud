import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  CLIP_HOOK_VER,
  CLIP_IMAGE_MAX,
  clipCaptureSource,
  clipEtag,
  clipPayloadFromBytes,
  clipPayloadFromCapture,
  extractShareUrl,
  imageMagicOk,
  isShareUrl,
  pickDeskImage,
  readCapturedClip,
  seenSeqFromEtag,
} from "../lib/clip-capture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

function matchSel(el, sel) {
  return String(sel)
    .split(",")
    .map((part) => part.trim())
    .some((part) => {
      if (part === "img") return el.tag === "img";
      if (part === "pre") return el.tag === "pre";
      if (part === "textarea") return el.tag === "textarea";
      if (part === "button") return el.tag === "button";
      if (part === "input") return el.tag === "input";
      if (part === "nav") return el.tag === "nav";
      if (part === "header") return el.tag === "header";
      if (part === "[role='button']") return el.attrs?.role === "button";
      if (part === "[role='dialog']") return el.attrs?.role === "dialog";
      if (part === "[role='alertdialog']") return el.attrs?.role === "alertdialog";
      return false;
    });
}

function makeEl(tag, attrs = {}, children = []) {
  const el = {
    tag,
    attrs,
    innerText: attrs.innerText || "",
    value: attrs.value || "",
    children,
    parentElement: null,
    currentSrc: attrs.currentSrc || attrs.src || "",
    src: attrs.src || "",
    naturalWidth: attrs.w || 0,
    naturalHeight: attrs.h || 0,
    width: attrs.w || 0,
    height: attrs.h || 0,
    getAttribute(name) {
      return this.attrs[name] || "";
    },
    closest(sel) {
      let node = this;
      while (node) {
        if (matchSel(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        if (node !== this && matchSel(node, sel)) out.push(node);
        for (const child of node.children || []) walk(child);
      };
      walk(this);
      return out;
    },
  };
  for (const child of children) child.parentElement = el;
  return el;
}

function boot({ nodes = [], selection = "", fetchImpl } = {}) {
  const listeners = {};
  const document = {
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((item) => item !== fn);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        if (matchSel(node, sel)) out.push(node);
        for (const child of node.children || []) walk(child);
      };
      for (const node of nodes) walk(node);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    createElement(tag) {
      if (tag !== "canvas") return { tag };
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toBlob(cb) {
          cb(new Blob([PNG], { type: "image/png" }));
        },
      };
    },
    getSelection() {
      return selection;
    },
  };
  let currentFetch = fetchImpl || (async () => {
    throw new Error("no fetch");
  });
  const clipboard = {
    async write() {
      throw new Error("NotAllowedError");
    },
    async writeText() {
      throw new Error("NotAllowedError");
    },
  };
  const sandbox = {
    document,
    navigator: { clipboard },
    Array,
    Object,
    String,
    Number,
    Promise,
    Uint8Array,
    Blob,
    Error,
    RegExp,
    Math,
    Date,
    JSON,
    btoa,
    atob,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  sandbox.fetch = (...args) => currentFetch(...args);
  vm.createContext(sandbox);
  vm.runInContext(clipCaptureSource(), sandbox);
  return {
    sandbox,
    listeners,
    setFetch(fn) {
      currentFetch = fn;
    },
  };
}

describe("share urls", () => {
  it("accepts conversation shares, short image shares, and public file urls", () => {
    assert.equal(extractShareUrl(" https://chatgpt.com/share/abc-def "), "https://chatgpt.com/share/abc-def");
    assert.equal(extractShareUrl("https://chatgpt.com/s/m_abc"), "https://chatgpt.com/s/m_abc");
    assert.equal(extractShareUrl("see https://chat.openai.com/share/abc."), "https://chat.openai.com/share/abc");
    assert.equal(
      extractShareUrl("https://files.oaiusercontent.com/file.png?sig=1"),
      "https://files.oaiusercontent.com/file.png?sig=1",
    );
    assert.equal(extractShareUrl("just a sentence"), "");
    assert.equal(isShareUrl("https://chatgpt.com/share/abc/more"), true);
    assert.equal(isShareUrl("https://example.com/share/abc"), false);
  });
});

describe("clip payloads", () => {
  it("keeps a real png and a share url, and drops junk", () => {
    const image = clipPayloadFromCapture({ seq: 3, kind: "image", mime: "image/png", b64: PNG_B64, text: "https://chatgpt.com/s/m_ok" });
    assert.equal(image.kind, "image");
    assert.equal(image.text, "https://chatgpt.com/s/m_ok");
    assert.equal(imageMagicOk("image/png", image.buf), true);
    assert.equal(clipEtag(image), '"cap-3"');
    assert.equal(seenSeqFromEtag(clipEtag(image)), 3);
    assert.equal(clipPayloadFromCapture({ seq: 1, kind: "image", mime: "image/png", b64: Buffer.from("hello").toString("base64") }), null);
    const big = Buffer.alloc(CLIP_IMAGE_MAX + 10, 1);
    big[0] = 0x89;
    big[1] = 0x50;
    big[2] = 0x4e;
    big[3] = 0x47;
    assert.equal(clipPayloadFromCapture({ seq: 1, kind: "image", mime: "image/png", b64: big.toString("base64") }), null);
    const link = clipPayloadFromBytes({ mime: "text/plain", buf: Buffer.from("https://chatgpt.com/share/abc\n"), share: "" });
    assert.equal(link.text, "https://chatgpt.com/share/abc");
    assert.equal(clipPayloadFromBytes({ mime: "text/plain", buf: Buffer.from("hello") }), null);
  });
});

describe("page hook", () => {
  it("keeps an image when Chromium rejects clipboard.write", async () => {
    const { sandbox } = boot();
    const item = {
      types: ["image/png"],
      getType: async () => new Blob([PNG], { type: "image/png" }),
    };
    const result = await sandbox.navigator.clipboard.write([item]);
    assert.equal(result, undefined);
    const payload = clipPayloadFromCapture(sandbox.__gpcClipBox);
    assert.equal(payload.kind, "image");
    assert.equal(payload.mime, "image/png");
  });

  it("stores share links and ignores ordinary text", async () => {
    const { sandbox } = boot();
    await sandbox.navigator.clipboard.writeText("hello from the chat");
    assert.equal(sandbox.__gpcClipBox.seq, 0);
    await sandbox.navigator.clipboard.writeText("https://chatgpt.com/s/m_link");
    assert.equal(sandbox.__gpcClipBox.kind, "text");
    assert.equal(sandbox.__gpcClipBox.text, "https://chatgpt.com/s/m_link");
  });

  it("captures the image next to a copy button and skips code copy", async () => {
    const img = makeEl("img", { src: "https://chatgpt.com/gen.png", w: 256, h: 256 });
    const button = makeEl("button", { "aria-label": "Copy", innerText: "Copy" });
    const wrap = makeEl("div", { innerText: "Copy" }, [img, makeEl("div", {}, [button])]);
    const { listeners, sandbox } = boot({ nodes: [wrap] });
    listeners.click[0]({ target: button });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sandbox.__gpcClipBox.kind, "image");

    const codeBtn = makeEl("button", { "aria-label": "Copy", innerText: "Copy" });
    const pre = makeEl("pre", {}, [codeBtn, img]);
    const second = boot({ nodes: [pre] });
    second.listeners.click[0]({ target: codeBtn });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(second.sandbox.__gpcClipBox.seq, 0);
  });

  it("reads a share url that lands in the dialog after copy link", async () => {
    const input = makeEl("input", { value: "" });
    const button = makeEl("button", { "aria-label": "复制链接" });
    const { listeners, sandbox } = boot({ nodes: [input, button] });
    listeners.click[0]({ target: button });
    input.value = "https://chatgpt.com/s/m_fromdialog";
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(sandbox.__gpcClipBox.text, "https://chatgpt.com/s/m_fromdialog");
  });

  it("reads a share url from the share response and ignores other fetches", async () => {
    const { sandbox, setFetch } = boot();
    setFetch(async () => ({
      ok: true,
      clone() {
        return this;
      },
      json: async () => ({ share_url: "https://chatgpt.com/share/from-api" }),
    }));
    await sandbox.fetch("https://chatgpt.com/backend-api/conversation");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sandbox.__gpcClipBox.seq, 0);
    await sandbox.fetch("https://chatgpt.com/backend-api/share/create");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sandbox.__gpcClipBox.text, "https://chatgpt.com/share/from-api");
  });

  it("picks the latest large generated image", async () => {
    const avatar = makeEl("img", { src: "https://cdn.example/avatar.png", w: 256, h: 256 });
    const photo = makeEl("img", { src: "https://chatgpt.com/gen.png", w: 512, h: 512 });
    const { sandbox } = boot({ nodes: [avatar, photo] });
    const picked = await sandbox.__gpcPickImage();
    assert.equal(picked.ok, true);
    assert.equal(picked.mime, "image/png");
    const payload = clipPayloadFromCapture({ seq: 1, kind: "image", mime: picked.mime, b64: picked.b64 });
    assert.equal(payload.kind, "image");
    const empty = await boot().sandbox.__gpcPickImage();
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没有/);
  });
});

describe("gateway helpers", () => {
  it("installs the hook when the page does not have it yet", async () => {
    let installed = false;
    const out = await readCapturedClip({
      async evaluate() {
        if (!installed) return { missing: true };
        return { seq: 4, kind: "text", mime: "text/plain", text: "https://chatgpt.com/s/m_z", b64: "" };
      },
      async install() {
        installed = true;
      },
    });
    assert.equal(out.text, "https://chatgpt.com/s/m_z");
    const same = await readCapturedClip({
      async evaluate() {
        return { unchanged: true, seq: 4 };
      },
    });
    assert.equal(same.unchanged, true);
  });

  it("turns a picked image into bytes the member can download", async () => {
    const out = await pickDeskImage({
      async evaluate(expr) {
        if (expr === "window.__gpcClipVer||0") return CLIP_HOOK_VER;
        return { ok: true, mime: "image/png", b64: PNG_B64, text: "https://chatgpt.com/share/abc" };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(out.payload.kind, "image");
    assert.equal(out.payload.text, "https://chatgpt.com/share/abc");
    const missing = await pickDeskImage({
      async evaluate() {
        return { ok: false, error: "对话里还没有可保存的图片" };
      },
    });
    assert.equal(missing.status, 404);
  });
});

describe("desk clipboard helper", () => {
  it("parses share urls and keeps an image when ctrl+c clears the selection", () => {
    const code = `
import importlib.util
spec = importlib.util.spec_from_file_location("clipd", "docker/clipd.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(mod.extract_share_url("see https://chatgpt.com/s/m_abc end"))
print(mod.extract_share_url("https://chatgpt.com/share/abc"))
print(mod.extract_share_url("nope"))
kept = mod.prefer_clip(("image/png", b"png-bytes", "https://chatgpt.com/s/m_abc"), ("text/plain; charset=utf-8", b"  ", ""))
print(kept[0])
print(kept[2])
replaced = mod.prefer_clip(("image/png", b"png-bytes", ""), ("text/plain; charset=utf-8", b"hello", ""))
print(replaced[1].decode())
html = b'<img src="data:image/png;base64,${PNG_B64}">'
found = mod.html_data_image(html)
print(found[0])
print(found[1][:8].hex())
`;
    const run = spawnSync("python3", ["-c", code], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trim().split("\n");
    assert.deepEqual(lines.slice(0, 6), [
      "https://chatgpt.com/s/m_abc",
      "https://chatgpt.com/share/abc",
      "",
      "image/png",
      "https://chatgpt.com/s/m_abc",
      "hello",
    ]);
    assert.equal(lines[6], "image/png");
    assert.equal(lines[7], PNG.subarray(0, 8).toString("hex"));
  });
});

describe("member ui wiring", () => {
  it("offers a local copy and a download without proxying chatgpt.com", () => {
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const server = readFileSync(resolve(root, "gateway/server.mjs"), "utf8");
    const source = clipCaptureSource();
    assert.match(ui, /id="take-image"/);
    assert.match(ui, /id="clip-offer"/);
    assert.match(ui, /下载图片/);
    assert.match(ui, /function clientShareUrl/);
    assert.match(ui, /oaiusercontent/);
    assert.match(ui, /复制到本机/);
    assert.match(server, /\/image\$/);
    assert.match(server, /installClipCapture/);
    assert.match(server, /x-gpc-share/);
    assert.doesNotMatch(source, /\/api\/|18790/);
    assert.match(source, /__gpcPickImage/);
  });
});
