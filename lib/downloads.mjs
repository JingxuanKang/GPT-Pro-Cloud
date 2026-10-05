/**
 * Chromium downloads land in the desk container. Record them and hand the
 * bytes to the member's browser. allowAndName stores the file as the CDP guid.
 */
import { readUstarFile } from "./desk-files.mjs";

export const DOWNLOAD_DIR = "/config/gpc-downloads";
export const DOWNLOAD_MAX_BYTES = 48 * 1024 * 1024;
export const DOWNLOAD_KEEP = 30;
export const DOWNLOAD_TTL_MS = 6 * 60 * 60 * 1000;
export const ACTOR_TTL_MS = 90_000;

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  zip: "application/zip",
};

export function downloadDirSetupCommand() {
  return [
    "sh",
    "-c",
    "mkdir -p /config/gpc-downloads && chown --reference=/config /config/gpc-downloads && chmod 755 /config/gpc-downloads",
  ];
}

export function safeDownloadId(id) {
  const s = String(id || "");
  if (!/^[A-Za-z0-9-]{8,80}$/.test(s)) return "";
  return s;
}

export function safeDownloadFilename(name) {
  const base = String(name || "download")
    .split(/[/\\]/)
    .pop()
    .replace(/^\.+/, "");
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff ()-]+/g, "_").slice(0, 120);
  return cleaned || "download";
}

export function mimeFromName(name) {
  const ext = String(name || "")
    .toLowerCase()
    .split(".")
    .pop();
  return MIME[ext] || "application/octet-stream";
}

export function attachmentDisposition(name) {
  const base = safeDownloadFilename(name);
  const ascii = base.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`;
}

export function containerDownloadPath(guid, filename, mode) {
  const id = safeDownloadId(guid);
  if (!id) return "";
  if (mode === "name") {
    const file = safeDownloadFilename(filename);
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

export async function readContainerDownload(
  docker,
  container,
  containerPath,
  { maxBytes = DOWNLOAD_MAX_BYTES, attempts = 6, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  const path = assertDownloadPath(containerPath);
  if (!docker?.getArchive || !path) {
    const err = new Error("文件还没准备好");
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
          const err = new Error("文件太大");
          err.status = 413;
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
  const err = new Error("文件还没准备好");
  err.status = last?.status === 404 ? 404 : last?.status || 404;
  if (err.status >= 500) err.status = 502;
  throw err;
}

export function downloadBehaviorParams(mode = "guid") {
  return {
    behavior: mode === "name" ? "allow" : "allowAndName",
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  };
}

export async function armBrowserDownloads({ send, on, onFile } = {}) {
  if (typeof send !== "function") return { armed: false, mode: "", dispose() {} };
  let mode = "guid";
  try {
    await send("Browser.setDownloadBehavior", downloadBehaviorParams("guid"));
  } catch {
    mode = "name";
    await send("Browser.setDownloadBehavior", downloadBehaviorParams("name"));
  }
  const names = new Map();
  const off =
    typeof on === "function"
      ? on((msg) => {
          const method = msg?.method;
          const params = msg?.params || {};
          if (method === "Browser.downloadWillBegin" || method === "Page.downloadWillBegin") {
            const guid = safeDownloadId(params.guid);
            if (!guid) return;
            names.set(guid, safeDownloadFilename(params.suggestedFilename));
            return;
          }
          if (method !== "Browser.downloadProgress" && method !== "Page.downloadProgress") return;
          if (params.state !== "completed") return;
          const guid = safeDownloadId(params.guid);
          if (!guid) return;
          const filename = names.get(guid) || safeDownloadFilename(params.suggestedFilename) || "download";
          const received = Number(params.receivedBytes || 0);
          if (received > DOWNLOAD_MAX_BYTES) return;
          const containerPath = assertDownloadPath(containerDownloadPath(guid, filename, mode));
          if (!containerPath) return;
          onFile?.({
            guid,
            filename,
            containerPath,
            bytes: received,
            mime: mimeFromName(filename),
          });
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

export function createDownloadHub({ now = () => Date.now() } = {}) {
  const items = new Map();
  const actors = new Map();
  const waiters = new Map();

  const prune = () => {
    const t = now();
    for (const [guid, item] of items) {
      if (t - item.at > DOWNLOAD_TTL_MS) items.delete(guid);
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

  return {
    noteActor(deskId, userId) {
      if (!deskId || !userId) return;
      actors.set(deskId, { userId, at: now() });
    },
    complete(deskId, meta, { occupants = [] } = {}) {
      const guid = safeDownloadId(meta?.guid);
      const containerPath = assertDownloadPath(meta?.containerPath);
      if (!deskId || !guid || !containerPath) return null;
      prune();
      const existing = items.get(guid);
      if (existing) return existing;
      const item = {
        guid,
        deskId,
        name: safeDownloadFilename(meta.filename),
        mime: meta.mime || mimeFromName(meta.filename),
        containerPath,
        bytes: Number(meta.bytes || 0),
        at: now(),
        owner: resolveOwner(deskId, occupants),
        delivered: new Set(),
      };
      items.set(guid, item);
      const deskItems = [...items.values()].filter((f) => f.deskId === deskId);
      if (deskItems.length > DOWNLOAD_KEEP) {
        deskItems
          .sort((a, b) => a.at - b.at)
          .slice(0, deskItems.length - DOWNLOAD_KEEP)
          .forEach((f) => items.delete(f.guid));
      }
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
        return {
          id: f.guid,
          name: f.name,
          mime: f.mime,
          bytes: f.bytes,
          at: f.at,
          auto,
        };
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
      if (ready) return Promise.resolve();
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
