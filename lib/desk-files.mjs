/**
 * Stage user-picked files inside the desk container so Chromium can
 * DOM.setFileInputFiles them. Wipe the token dir afterwards. Never log bytes.
 */
import { randomBytes } from "node:crypto";
import { deskContainerName } from "./docker.mjs";
import { safeUploadName } from "./file-chooser.mjs";

export function uploadToken() {
  return randomBytes(6).toString("hex");
}

export function deskUploadDir(token) {
  return `/tmp/gpc-up-${String(token || "").replace(/[^a-z0-9]/gi, "")}`;
}

function octalField(n, width) {
  return n.toString(8).padStart(width - 1, "0") + "\0";
}

/** Minimal ustar. entries: { name, bytes? , directory? } */
export function packUstar(entries) {
  const chunks = [];
  for (const entry of entries || []) {
    const name = String(entry.name || "").replace(/^\/+/, "").slice(0, 99);
    if (!name) continue;
    const directory = !!entry.directory;
    const data = directory ? Buffer.alloc(0) : Buffer.from(entry.bytes || []);
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, "utf8");
    header.write((directory ? "0000755" : "0000644") + "\0", 100, 8, "latin1");
    header.write("0000000\0", 108, 8, "latin1");
    header.write("0000000\0", 116, 8, "latin1");
    header.write(octalField(data.length, 12), 124, 12, "latin1");
    header.write(octalField(Math.floor(Date.now() / 1000), 12), 136, 12, "latin1");
    header.write("        ", 148, 8, "latin1");
    header.write(directory ? "5" : "0", 156, 1, "latin1");
    header.write("ustar\0", 257, 6, "latin1");
    header.write("00", 263, 2, "latin1");
    let sum = 0;
    for (const b of header) sum += b;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
    chunks.push(header);
    if (!directory && data.length) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

export async function stageDeskUpload(deskId, files, { docker, containerName } = {}) {
  if (!docker?.putArchive) throw new Error("无法上传文件");
  const token = uploadToken();
  const dirName = `gpc-up-${token}`;
  const container = containerName || deskContainerName(deskId);
  const entries = [{ name: dirName, directory: true }];
  const paths = [];
  for (const f of files || []) {
    const name = safeUploadName(f.name);
    entries.push({ name: `${dirName}/${name}`, bytes: f.bytes });
    paths.push(`/tmp/${dirName}/${name}`);
  }
  await docker.putArchive(container, "/tmp", packUstar(entries));
  return {
    token,
    paths,
    async wipe() {
      try {
        await docker.exec?.(container, ["rm", "-rf", `/tmp/${dirName}`]);
      } catch {
        /* /tmp leftover is better than a hang */
      }
    },
  };
}
