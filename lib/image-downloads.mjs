/**
 * When ChatGPT's own Save / Download does hit Chromium, the file lands in
 * the desk container. Read it once it is a complete image and keep the bytes
 * until the member's browser downloads them. Click-hook captures share this
 * hub so a blob/CDN save that never reaches the download manager still
 * arrives on the same poll.
 */
import { readUstarFile } from "./desk-files.mjs";
import { filenameForImage, newImageId, sniffImage } from "./gpt-image.mjs";

export const DOWNLOAD_DIR = "/config/gpc-downloads";
export const DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;
export const DOWNLOAD_KEEP = 4;
export const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
export const ACTOR_TTL_MS = 90_000;

export function downloadDirSetupCommand() {
  return [
    "sh",
    "-c",
    "mkdir -p /config/gpc-downloads /etc/chromium/policies/managed && chown --reference=/config /config/gpc-downloads 2>/dev/null || true && chmod 755 /config/gpc-downloads && printf '%s\\n' '{\"DownloadDirectory\":\"/config/gpc-downloads\",\"PromptForDownload\":false}' > /etc/chromium/policies/managed/gpc-downloads.json 2>/dev/null || true",
  ];
}

export function safeDownloadId(id) {
  const s = String(id || "");
  if (!/^[A-Za-z0-9-]{8,80}$/.test(s)) return "";
  return s;
}

export function mightBeImageDownload(name) {
  const base = String(name || "")
    .split(/[/\\]/)
    .pop()
    .toLowerCase()
    .replace(/\.crdownload$/, "");
  if (!base) return true;
  if (/\.(png|jpe?g|gif|webp)$/.test(base)) return true;
  if (/\.[a-z0-9]{1,8}$/.test(base)) return false;
  return true;
}

export function containerDownloadPath(guid, filename, mode) {
  const id = safeDownloadId(guid);
  if (!id) return "";
  if (mode === "name") {
    const file = String(filename || "")
      .split(/[/\\]/)
      .pop()
      .replace(/^\.+/, "")
      .replace(/[\0/\\]/g, "");
    if (!file || file.includes("..")) return "";
    return `${DOWNLOAD_DIR}/${file}`;
  }
  return `${DOWNLOAD_DIR}/${id}`;
}

export function assertDownloadPath(p) {
  const path = String(p || "");
  if (!path.startsWith(`${DOWNLOAD_DIR}/`)) return "";
  if (path.includes("..") || path.includes("\0") || path.includes("//")) return "";
  return path;
}

export function downloadBehaviorParams(mode = "guid") {
  return {
    behavior: mode === "name" ? "allow" : "allowAndName",
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  };
}

export async function readContainerDownload(
  docker,
  container,
  containerPath,
  { maxBytes = DOWNLOAD_MAX_BYTES, attempts = 6, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), accept } = {},
) {
  const path = assertDownloadPath(containerPath);
  if (!docker?.getArchive || !path) {
    const err = new Error("图片还没准备好");
    err.status = 404;
    throw err;
  }
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const tar = await docker.getArchive(container, path);
      const file = readUstarFile(tar);
      if (file?.bytes?.length) {
        if (file.bytes.length > maxBytes) {
          const err = new Error("图片太大");
          err.status = 413;
          throw err;
        }
        if (accept && !accept(file.bytes)) {
          const err = new Error("图片不完整");
          err.status = 409;
          throw err;
        }
        return file.bytes;
      }
    } catch (e) {
      if (e.status === 413) throw e;
      last = e;
    }
    if (i + 1 < attempts) await sleep(120);
  }
  const err = new Error(last?.status === 409 ? "图片不完整" : "图片还没准备好");
  err.status = last?.status === 409 ? 409 : 404;
  throw err;
}

export function imageBytesReady(bytes) {
  const info = sniffImage(bytes);
  return !!(info && !info.incomplete);
}

export async function armBrowserImageDownloads({ send, on, onBegin, onFile } = {}) {
  if (typeof send !== "function") return { armed: false, mode: "", dispose() {} };
  let mode = "guid";
  try {
    await send("Browser.setDownloadBehavior", downloadBehaviorParams("guid"));
  } catch {
    mode = "name";
    try {
      await send("Browser.setDownloadBehavior", downloadBehaviorParams("name"));
    } catch {
      return { armed: false, mode: "", dispose() {} };
    }
  }
  const names = new Map();
  const off =
    typeof on === "function"
      ? on((msg) => {
          const method = msg?.method || "";
          const params = msg?.params || {};
          if (method === "Browser.downloadWillBegin" || method === "Page.downloadWillBegin") {
            const guid = safeDownloadId(params.guid);
            if (!guid) return;
            const filename = String(params.suggestedFilename || "");
            if (!mightBeImageDownload(filename)) return;
            names.set(guid, filename);
            onBegin?.({ guid, filename, state: "inProgress" });
            return;
          }
          if (method !== "Browser.downloadProgress" && method !== "Page.downloadProgress") return;
          const guid = safeDownloadId(params.guid);
          if (!guid || !names.has(guid)) return;
          const filename = names.get(guid) || "";
          if (params.state === "canceled") {
            names.delete(guid);
            return;
          }
          onBegin?.({
            guid,
            filename,
            state: params.state || "inProgress",
            receivedBytes: Number(params.receivedBytes || 0),
            totalBytes: Number(params.totalBytes || 0),
          });
          if (params.state !== "completed") return;
          const received = Number(params.receivedBytes || 0);
          if (received > DOWNLOAD_MAX_BYTES) return;
          const containerPath = assertDownloadPath(containerDownloadPath(guid, filename, mode));
          if (!containerPath) return;
          onFile?.({ guid, filename, containerPath, bytes: received });
        })
      : () => {};
  return {
    armed: true,
    mode,
    dispose() {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    },
  };
}

export function createImageDownloadHub({ now = () => Date.now() } = {}) {
  const items = new Map();
  const actors = new Map();
  const waiters = new Map();
  const browserSaves = new Map();

  const prune = () => {
    const t = now();
    for (const [guid, item] of items) {
      if (t - item.at > DOWNLOAD_TTL_MS) items.delete(guid);
    }
    for (const [deskId, list] of browserSaves) {
      const keep = list.filter((row) => t - row.at < 20_000);
      if (keep.length) browserSaves.set(deskId, keep);
      else browserSaves.delete(deskId);
    }
  };

  const wake = (deskId) => {
    const q = waiters.get(deskId) || [];
    waiters.delete(deskId);
    for (const fn of q) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  };

  const resolveOwner = (deskId, occupants) => {
    const ids = (occupants || []).map((o) => (typeof o === "string" ? o : o?.id)).filter(Boolean);
    const actor = actors.get(deskId);
    const t = now();
    if (actor && t - actor.at < ACTOR_TTL_MS && (!ids.length || ids.includes(actor.userId))) return actor.userId;
    if (ids.length === 1) return ids[0];
    return "";
  };

  const trim = (deskId) => {
    const deskItems = [...items.values()].filter((f) => f.deskId === deskId);
    if (deskItems.length <= DOWNLOAD_KEEP) return;
    deskItems
      .sort((a, b) => a.at - b.at)
      .slice(0, deskItems.length - DOWNLOAD_KEEP)
      .forEach((f) => items.delete(f.guid));
  };

  return {
    noteActor(deskId, userId) {
      if (!deskId || !userId) return;
      actors.set(deskId, { userId, at: now() });
    },
    noteBrowserSave(deskId, meta) {
      if (!deskId) return;
      prune();
      const list = browserSaves.get(deskId) || [];
      list.push({
        at: now(),
        filename: String(meta?.filename || ""),
        state: meta?.state || "inProgress",
        receivedBytes: Number(meta?.receivedBytes || meta?.bytes || 0),
        totalBytes: Number(meta?.totalBytes || 0),
      });
      browserSaves.set(deskId, list.slice(-8));
    },
    acceptClickCapture(deskId, byteLength, filename) {
      prune();
      const recent = browserSaves.get(deskId) || [];
      const t = now();
      for (const row of recent) {
        if (t - row.at > 20_000) continue;
        if (filename && row.filename && filename === row.filename) return false;
        if (byteLength && row.totalBytes && Math.abs(row.totalBytes - byteLength) < 64) return false;
        if (byteLength && row.state === "completed" && row.receivedBytes === byteLength) return false;
        if (row.state !== "completed" && t - row.at < 4000) return false;
      }
      return true;
    },
    completeBytes(deskId, image, { occupants = [], via = "page" } = {}) {
      const bytes = image?.bytes;
      if (!deskId || !bytes?.length) return null;
      if (!imageBytesReady(bytes)) return null;
      if (bytes.length > DOWNLOAD_MAX_BYTES) return null;
      prune();
      const mime = image.mime || sniffImage(bytes).mime;
      const dup = [...items.values()].find(
        (f) => f.deskId === deskId && now() - f.at < 15_000 && f.bytes.length === bytes.length && f.mime === mime,
      );
      if (dup) return null;
      const item = {
        guid: newImageId(),
        deskId,
        name: filenameForImage(image.filename, mime),
        mime,
        bytes,
        at: now(),
        owner: resolveOwner(deskId, occupants),
        delivered: new Set(),
        via,
      };
      items.set(item.guid, item);
      trim(deskId);
      wake(deskId);
      return item;
    },
    get(deskId, guid) {
      prune();
      const item = items.get(safeDownloadId(guid));
      if (!item || item.deskId !== deskId) return null;
      return item;
    },
    listFor(deskId, userId, { consumeAuto = false } = {}) {
      prune();
      const files = [...items.values()]
        .filter((f) => f.deskId === deskId)
        .sort((a, b) => b.at - a.at);
      const out = files.map((f) => {
        const auto = !f.delivered.has(userId) && (!f.owner || f.owner === userId);
        return { id: f.guid, name: f.name, mime: f.mime, bytes: f.bytes.length, at: f.at, auto, via: f.via };
      });
      if (consumeAuto && userId) {
        for (const row of out) {
          if (!row.auto) continue;
          items.get(row.id)?.delivered.add(userId);
        }
      }
      return out;
    },
    wait(deskId, userId, ms = 20_000) {
      const ready = this.listFor(deskId, userId).some((f) => f.auto);
      if (ready || ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        let timer;
        let onReady;
        const finish = () => {
          clearTimeout(timer);
          const q = (waiters.get(deskId) || []).filter((fn) => fn !== onReady);
          if (q.length) waiters.set(deskId, q);
          else waiters.delete(deskId);
          resolve();
        };
        onReady = () => finish();
        timer = setTimeout(finish, ms);
        const q = waiters.get(deskId) || [];
        q.push(onReady);
        waiters.set(deskId, q);
      });
    },
  };
}
