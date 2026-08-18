import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LEGACY_SALT = "gpc-v0";

export function requirePasswordConfigured(password) {
  const p = String(password ?? "").trim();
  if (!p) throw new Error("AUTH_PASSWORD is empty — refusing to start");
  return p;
}

/** s1:<salt hex>:<scrypt hex> — 每个密码独立随机盐 */
export function hashPassword(password) {
  const plain = requirePasswordConfigured(password);
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 32);
  return `s1:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function needsRehash(stored) {
  return !String(stored || "").startsWith("s1:");
}

export function passwordMatches(plain, stored) {
  if (typeof plain !== "string" || !plain || !stored) return false;
  let expected;
  let got;
  const s = typeof stored === "string" ? stored : Buffer.isBuffer(stored) ? `legacy:${stored.toString("base64")}` : "";
  if (s.startsWith("s1:")) {
    const [, saltHex, hashHex] = s.split(":");
    if (!saltHex || !hashHex) return false;
    expected = Buffer.from(hashHex, "hex");
    got = scryptSync(plain, Buffer.from(saltHex, "hex"), 32);
  } else {
    // 旧格式：固定盐 scrypt 的 base64（登录成功后由调用方 rehash）
    expected = Buffer.from(s.startsWith("legacy:") ? s.slice(7) : s, "base64");
    got = scryptSync(plain, LEGACY_SALT, 32);
  }
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

export function createSessionToken() {
  return randomBytes(24).toString("hex");
}

export function readSession(sessions, token, now = Date.now(), ttlMs = 14 * 24 * 60 * 60 * 1000) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < now) {
    sessions.delete(token);
    return null;
  }
  if (s.expires - now < ttlMs / 2) s.expires = now + ttlMs;
  return s;
}

/**
 * 登录限流：同一 key（如 ip|username）连续失败超过上限后，在窗口期内拒绝尝试。
 * 全内存，进程重启即清零 —— 面板部署在内网，这个强度足够挡住脚本爆破。
 */
export function createLoginLimiter({ maxFails = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const fails = new Map(); // key → { count, until }
  const prune = (now) => {
    if (fails.size < 1024) return;
    for (const [k, v] of fails) if (v.until < now) fails.delete(k);
  };
  return {
    blocked(key, now = Date.now()) {
      const rec = fails.get(key);
      if (!rec) return false;
      if (rec.until < now) {
        fails.delete(key);
        return false;
      }
      return rec.count >= maxFails;
    },
    fail(key, now = Date.now()) {
      prune(now);
      const rec = fails.get(key);
      if (!rec || rec.until < now) {
        fails.set(key, { count: 1, until: now + windowMs });
        return;
      }
      rec.count += 1;
      rec.until = now + windowMs;
    },
    ok(key) {
      fails.delete(key);
    },
  };
}

/**
 * 会话存储：Map 接口 + JSON 文件持久化，网关重启不掉线。
 * 写入合并（登录/登出立即落盘，续期靠周期 flush），过期项在落盘时清理。
 */
export function createSessionStore({ file, ttlMs = 14 * 24 * 60 * 60 * 1000, flushEveryMs = 5 * 60 * 1000 } = {}) {
  const map = new Map();
  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const now = Date.now();
      for (const [token, rec] of Object.entries(raw.sessions || {})) {
        if (rec && typeof rec.expires === "number" && rec.expires > now && rec.userId) map.set(token, rec);
      }
    } catch {
      /* 坏文件当空处理 */
    }
  }
  const persist = () => {
    if (!file) return;
    const now = Date.now();
    for (const [token, rec] of map) if (rec.expires <= now) map.delete(token);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions: Object.fromEntries(map) }));
    renameSync(tmp, file);
  };
  let timer = null;
  const scheduleFlush = () => {
    if (!file || timer) return;
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, flushEveryMs);
    if (typeof timer.unref === "function") timer.unref();
  };
  return {
    get(token) {
      scheduleFlush();
      return map.get(token);
    },
    set(token, rec) {
      map.set(token, rec);
      persist();
    },
    delete(token) {
      const had = map.delete(token);
      if (had) persist();
      return had;
    },
    deleteByUser(userId) {
      let removed = 0;
      for (const [token, rec] of map) {
        if (rec.userId === userId) {
          map.delete(token);
          removed += 1;
        }
      }
      if (removed) persist();
      return removed;
    },
    get size() {
      return map.size;
    },
    ttlMs,
  };
}
