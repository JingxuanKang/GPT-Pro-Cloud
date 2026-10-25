import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyImeCommands, imeCommands } from "../lib/ime.mjs";
import { packUstar, readUstarFile } from "../lib/desk-files.mjs";
import { keyDispatchList } from "../lib/screencast.mjs";
import {
  armBrowserDownloads,
  assertDownloadPath,
  attachmentDisposition,
  containerDownloadPath,
  createDownloadHub,
  downloadDirSetupCommand,
  readContainerDownload,
  safeDownloadFilename,
  safeDownloadId,
} from "../lib/downloads.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("IME composition plans", () => {
  it("previews with imeSetComposition and commits with insertText", async () => {
    const preview = imeCommands({ phase: "update", text: "nihao" });
    assert.equal(preview.commands[0].method, "Input.imeSetComposition");
    assert.equal(preview.commands[0].params.text, "nihao");
    assert.equal(preview.commands[0].params.selectionStart, 5);

    const commit = imeCommands({ phase: "commit", text: "你好" });
    assert.equal(commit.commands.length, 1);
    assert.equal(commit.commands[0].method, "Input.insertText");
    assert.equal(commit.commands[0].params.text, "你好");

    const calls = [];
    const out = await applyImeCommands(async (method, params) => {
      calls.push({ method, params });
    }, { phase: "commit", text: "你好" });
    assert.equal(out.ok, true);
    assert.equal(calls[0].method, "Input.insertText");
  });

  it("clears a cancelled composition and rejects junk", () => {
    const cancel = imeCommands({ phase: "cancel", text: "x" });
    assert.equal(cancel.commands[0].params.text, "");
    assert.equal(imeCommands({ phase: "start" }).commands.length, 0);
    assert.equal(imeCommands({ phase: "nope" }).status, 400);
    assert.equal(imeCommands({ phase: "commit", text: "a".repeat(4001) }).status, 413);
    assert.equal(imeCommands({ phase: "update", text: "a\u0000b" }).commands[0].params.text, "ab");
  });

  it("does not turn IME preedit into key events, and still sends Enter", () => {
    assert.deepEqual(keyDispatchList({ composing: true, event: "keyDown", key: "n", code: "KeyN" }), []);
    assert.deepEqual(keyDispatchList({ event: "keyDown", key: "Process", code: "KeyN" }), []);
    const letter = keyDispatchList({ event: "keyDown", key: "a", code: "KeyA" });
    assert.equal(letter[0].type, "char");
    assert.equal(letter[0].text, "a");
    const enter = keyDispatchList({ event: "keyDown", key: "Enter", code: "Enter" });
    assert.equal(enter[0].type, "rawKeyDown");
    const up = keyDispatchList({ event: "keyUp", key: "Enter", code: "Enter" });
    assert.equal(up[0].type, "keyUp");
  });
});

describe("desk downloads reach the member browser", () => {
  it("rejects traversal and keeps files under the download directory", () => {
    assert.equal(safeDownloadId("../etc/passwd"), "");
    assert.equal(safeDownloadId("abc"), "");
    assert.equal(safeDownloadId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"), "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    assert.equal(safeDownloadFilename("../../图片.png"), "图片.png");
    assert.equal(safeDownloadFilename("C:\\Users\\a\\shot.webp"), "shot.webp");
    const guid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    assert.equal(containerDownloadPath(guid, "图片.png", "guid"), `/config/gpc-downloads/${guid}`);
    assert.equal(assertDownloadPath("/config/gpc-downloads/../chromium/Cookies"), "");
    assert.match(attachmentDisposition("图片.png"), /filename\*=UTF-8''/);
    assert.match(downloadDirSetupCommand().join(" "), /gpc-downloads/);
  });

  it("round-trips a file through ustar the way Docker archive does", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const tar = packUstar([{ name: "gpc-downloads/pic.png", bytes }]);
    const file = readUstarFile(tar);
    assert.equal(file.name, "gpc-downloads/pic.png");
    assert.deepEqual(file.bytes, bytes);
  });

  it("attributes a finished download to the recent actor and serves it once automatically", async () => {
    let t = 1_000;
    const hub = createDownloadHub({ now: () => t });
    hub.noteActor("a", "ada");
    const guid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    hub.complete(
      "a",
      {
        guid,
        filename: "图片.png",
        containerPath: `/config/gpc-downloads/${guid}`,
        bytes: 8,
        mime: "image/png",
      },
      { occupants: ["ada", "bea"] },
    );
    const ada = hub.listFor("a", "ada", { consumeAuto: true });
    assert.equal(ada[0].auto, true);
    assert.equal(ada[0].name, "图片.png");
    assert.equal(hub.listFor("a", "ada")[0].auto, false);
    assert.equal(hub.listFor("a", "bea")[0].auto, false);
    assert.equal(hub.get("a", guid).containerPath, `/config/gpc-downloads/${guid}`);
    assert.equal(hub.get("b", guid), null);

    const calls = [];
    const listeners = [];
    const armed = await armBrowserDownloads({
      send: async (method, params) => {
        calls.push({ method, params });
        if (method === "Browser.setDownloadBehavior" && params.behavior === "allowAndName") {
          throw new Error("old chromium");
        }
      },
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      onFile: (meta) => calls.push({ file: meta }),
    });
    assert.equal(armed.mode, "name");
    assert.equal(calls[1].params.behavior, "allow");
    listeners[0]({
      method: "Browser.downloadWillBegin",
      params: { guid, suggestedFilename: "../图片.png" },
    });
    listeners[0]({
      method: "Browser.downloadProgress",
      params: { guid, state: "inProgress", receivedBytes: 4 },
    });
    listeners[0]({
      method: "Browser.downloadProgress",
      params: { guid, state: "completed", receivedBytes: 8 },
    });
    const saved = calls.find((c) => c.file);
    assert.equal(saved.file.filename, "图片.png");
    assert.equal(saved.file.containerPath, "/config/gpc-downloads/图片.png");
  });

  it("reads the container file after a short delay and refuses oversize bytes", async () => {
    const bytes = Buffer.from("png-bytes");
    let n = 0;
    const docker = {
      async getArchive() {
        n += 1;
        if (n === 1) {
          const err = new Error("missing");
          err.status = 404;
          throw err;
        }
        return packUstar([{ name: "pic.png", bytes }]);
      },
    };
    const got = await readContainerDownload(docker, "gpt-pro-cloud-a", "/config/gpc-downloads/pic.png", {
      sleep: async () => {},
    });
    assert.deepEqual(got, bytes);
    await assert.rejects(
      () =>
        readContainerDownload(
          {
            async getArchive() {
              return packUstar([{ name: "big.bin", bytes: Buffer.alloc(32) }]);
            },
          },
          "c",
          "/config/gpc-downloads/big.bin",
          { maxBytes: 8, sleep: async () => {} },
        ),
      (err) => err.status === 413,
    );
  });
});

describe("issue 26 wiring", () => {
  it("hooks composition into both desk paths and proxies downloads to the browser", () => {
    const ui = readFileSync(resolve(root, "gateway/web/app.js"), "utf8");
    const gw = readFileSync(resolve(root, "gateway/server.mjs"), "utf8");
    const hide = readFileSync(resolve(root, "docker/hide-kasm.sh"), "utf8");
    const init = readFileSync(resolve(root, "docker/update-autostart.sh"), "utf8");
    assert.match(ui, /compositionend/);
    assert.match(ui, /enableIME/);
    assert.match(ui, /\/api\/desks\/\$\{id\}\/ime/);
    assert.match(ui, /id="seat-ime"/);
    assert.match(ui, /id="desk-ime"/);
    assert.match(ui, /id="desk-ime-btn"/);
    assert.match(ui, /aria-label="中文输入"/);
    assert.match(ui, /opacity:1!important/);
    assert.doesNotMatch(ui, /opacity:\.02!important/);
    assert.match(ui, /id="download-files"/);
    assert.match(ui, /\/api\/desks\/\$\{id\}\/downloads/);
    assert.match(ui, /triggerLocalDownload/);
    assert.match(ui, /rfb\.sendKey/);
    assert.doesNotMatch(ui, /width:2px!important;height:2px!important/);
    assert.match(gw, /applyDeskIme/);
    assert.match(gw, /Input\.insertText|applyImeCommands/);
    assert.match(gw, /ensureDeskDownloads/);
    const imeSenderFn = gw.slice(gw.indexOf("async function imeSender"), gw.indexOf("async function applyDeskIme"));
    assert.match(imeSenderFn, /ensureExclusiveFilePipe/);
    assert.ok(imeSenderFn.indexOf("ensureExclusiveFilePipe") < imeSenderFn.indexOf("findChatGptTargetId"));
    assert.match(gw, /content-disposition/);
    assert.match(hide, /overflow: visible !important/);
    assert.match(hide, /opacity: 1 !important/);
    assert.doesNotMatch(hide, /opacity: 0\.02/);
    assert.doesNotMatch(hide, /width: 2px !important/);
    assert.match(init, /gpc-downloads/);
    assert.match(init, /DownloadDirectory/);
  });
});
