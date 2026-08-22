import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyDeskUpload,
  applyFilesToChooser,
  armFileChooser,
  cancelFileChooser,
  classifyDeskFiles,
  createChooserRegistry,
  FILE_EMPTY,
  FILE_NEED_CHAT,
  FILE_TOO_BIG,
  FILE_UPLOAD_MAX,
  safeUploadName,
} from "../lib/file-chooser.mjs";
import { deskUploadDir, packUstar } from "../lib/desk-files.mjs";

describe("exclusive VNC local file apply", () => {
  it("rejects oversized and empty uploads with a Chinese error", () => {
    assert.equal(classifyDeskFiles([]).error, FILE_EMPTY);
    assert.equal(classifyDeskFiles([{ name: "a.pdf", data: "" }]).error, FILE_EMPTY);
    const big = Buffer.alloc(FILE_UPLOAD_MAX + 1, 1);
    const over = classifyDeskFiles([{ name: "big.pdf", bytes: big }]);
    assert.equal(over.ok, false);
    assert.equal(over.status, 413);
    assert.equal(over.error, FILE_TOO_BIG);
    assert.equal(over.error, "文件太大，请选择 12MB 以内的文件");
    const ok = classifyDeskFiles([{ name: "note.txt", mime: "text/plain", bytes: Buffer.from("hi") }]);
    assert.equal(ok.ok, true);
    assert.equal(ok.files[0].name, "note.txt");
  });

  it("strips remote paths from filenames", () => {
    assert.equal(safeUploadName("../../etc/passwd"), "passwd");
    assert.equal(safeUploadName("C:\\\\Users\\\\a\\\\报告.docx"), "报告.docx");
    assert.equal(safeUploadName(""), "file");
    assert.equal(deskUploadDir("abC12").startsWith("/tmp/gpc-up-"), true);
  });

  it("intercepts the remote chooser and applies local files, or cancels", async () => {
    const calls = [];
    const send = async (method, params) => {
      calls.push({ method, params });
      return {};
    };
    const listeners = [];
    await armFileChooser({
      send,
      sessionId: "s1",
      on: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      onOpened: (info) => {
        calls.push({ opened: info });
      },
    });
    assert.equal(calls.some((c) => c.method === "Page.setInterceptFileChooserDialog" && c.params.enabled === true), true);
    listeners[0]({
      method: "Page.fileChooserOpened",
      sessionId: "s1",
      params: { backendNodeId: 44, mode: "selectMultiple" },
    });
    assert.equal(calls.some((c) => c.opened?.backendNodeId === 44), true);

    await applyFilesToChooser(send, { backendNodeId: 44, paths: ["/tmp/gpc-up-x/a.pdf"] });
    const set = calls.find((c) => c.method === "DOM.setFileInputFiles");
    assert.deepEqual(set.params, { files: ["/tmp/gpc-up-x/a.pdf"], backendNodeId: 44 });

    await cancelFileChooser(send, { backendNodeId: 44 });
    const cancel = calls.filter((c) => c.method === "DOM.setFileInputFiles").at(-1);
    assert.deepEqual(cancel.params.files, []);
  });

  it("applyDeskUpload uses staged paths and wipes them on exclusive VNC", async () => {
    const wiped = [];
    const sent = [];
    const out = await applyDeskUpload({
      files: [
        {
          name: "brief.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          bytes: Buffer.from("PK"),
        },
      ],
      targetId: "t-vnc",
      pending: { backendNodeId: 7, targetId: "t-vnc" },
      attach: async () => ({
        cdp: {
          send: async (method, params) => {
            sent.push({ method, params });
            return {};
          },
        },
        sessionId: "s",
        release: async () => {},
      }),
      stage: async (files) => {
        assert.equal(files[0].name, "brief.docx");
        return { paths: ["/tmp/gpc-up-1/brief.docx"], wipe: async () => wiped.push(1) };
      },
    });
    assert.equal(out.ok, true);
    assert.equal(sent[0].method, "DOM.setFileInputFiles");
    assert.deepEqual(sent[0].params.files, ["/tmp/gpc-up-1/brief.docx"]);
    assert.deepEqual(wiped, [1]);
  });

  it("applies pdf and images through the exclusive CDP pipe without 多人分屏", async () => {
    const sent = [];
    const pdf = await applyDeskUpload({
      files: [{ name: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }],
      targetId: "t-vnc",
      pending: { backendNodeId: 3, targetId: "t-vnc" },
      attach: async () => ({
        cdp: {
          send: async (method, params) => {
            sent.push({ method, params });
            return {};
          },
        },
        sessionId: "s",
        release: async () => {},
      }),
      stage: async () => ({ paths: ["/tmp/gpc-up-1/a.pdf"], wipe: async () => {} }),
    });
    assert.equal(pdf.ok, true);
    assert.equal(sent[0].method, "DOM.setFileInputFiles");
    const missing = await applyDeskUpload({
      files: [{ name: "a.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF") }],
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, FILE_NEED_CHAT);
  });

  it("chooser registry hands a pending open to a waiter", async () => {
    const reg = createChooserRegistry();
    const waiting = reg.wait("a", "u1", 200);
    reg.set("a", "u1", { backendNodeId: 3, mode: "selectSingle", targetId: "t" });
    const got = await waiting;
    assert.equal(got.backendNodeId, 3);
    assert.equal(reg.take("a", "u1").targetId, "t");
    assert.equal(reg.get("a", "u1"), null);
  });

  it("packs an ustar that names the staged file", () => {
    const tar = packUstar([
      { name: "gpc-up-aa", directory: true },
      { name: "gpc-up-aa/note.txt", bytes: Buffer.from("hello") },
    ]);
    assert.equal(tar.length % 512, 0);
    assert.equal(tar.toString("utf8", 0, 20).startsWith("gpc-up-aa"), true);
    const fileHdr = tar.subarray(512, 1024).toString("utf8");
    assert.match(fileHdr, /gpc-up-aa\/note\.txt/);
  });
});
