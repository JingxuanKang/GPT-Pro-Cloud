import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import httpProxy from "http-proxy";
import { createSessionToken, readSession, createLoginLimiter, createSessionStore } from "../lib/auth.mjs";
import { parseInstances } from "../lib/instances.mjs";
import { createDeskRegistry, provisionDesk, retireDesk } from "../lib/desks.mjs";
import { createDockerClient, ensureDeskContainer, removeDeskContainer } from "../lib/docker.mjs";
import { createUserStore } from "../lib/users.mjs";
import { createPresence } from "../lib/presence.mjs";
import { createSocketHub, kickLiveSession } from "../lib/kick.mjs";
import { evaluateInDesk, waitForDesk, peekClipboard, isShareUrl, SHARE_CLICK, TAB_CLIP_READ, projectOnboardScript, sleep } from "../lib/chrome.mjs";
import { applyDeskProxyLive, applyDeskProxiesLive } from "../lib/proxy.mjs";
import { createSeatRegistry, parseTabSeatCap, publicSeat } from "../lib/seats.mjs";
import { attachSeatTarget, closeTarget, createParkedChatGPTTab, deskHasChatGPTSession, evaluateOnTarget, targetExists } from "../lib/cdp.mjs";
import { startSeatScreencast } from "../lib/screencast.mjs";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8080);
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASSWORD = String(process.env.AUTH_PASSWORD || "").trim(); // 可选：留空走首次访问向导
const SEED = parseInstances(process.env.INSTANCES || "a,b");
const registry = createDeskRegistry(SEED);
const docker = createDockerClient({
  socketPath: process.env.DOCKER_SOCKET || "/var/run/docker.sock",
  templateName: process.env.DESKTOP_TEMPLATE || "gpt-pro-cloud-a",
});
const VNC_USER = process.env.VNC_USER || "abc";
const VNC_PASSWORD = process.env.VNC_PASSWORD || "";
const COOKIE = "gpc_session";
const DESK = "gpc_desk";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const WEB = join(dirname(fileURLToPath(import.meta.url)), "web");

const USERS_FILE = process.env.USERS_FILE || "/data/users.json";
const users = createUserStore({
  file: USERS_FILE,
  adminUser: AUTH_USER,
  adminPassword: AUTH_PASSWORD,
  deskIds: SEED.map((i) => i.id),
});
for (const id of users.extraDeskIds()) registry.add(id);
const presence = createPresence();
const seats = createSeatRegistry({ cap: parseTabSeatCap(process.env.TAB_SEATS_MAX) });
const sessions = createSessionStore({ file: join(dirname(USERS_FILE), "sessions.json"), ttlMs: TTL_MS });
const liveSockets = createSocketHub();
const seatWss = new WebSocketServer({ noServer: true });
const loginLimiter = createLoginLimiter({ maxFails: 10, windowMs: 15 * 60 * 1000 });
const onboardLocks = new Map();

async function withOnboardLock(id, fn) {
  const prev = onboardLocks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  onboardLocks.set(
    id,
    prev.then(() => gate),
  );
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

async function runOnboard(id, name, { create = true, targetId } = {}) {
  await waitForDesk(id, 45000, { targetId });
  let last = { ok: false, error: "工作区还没准备好" };
  for (let i = 0; i < 3; i++) {
    last = await evaluateInDesk(id, projectOnboardScript(name, { create }), 28000, { targetId });
    if (last?.ok) return last;
    if (!create && last?.error === "找不到项目") {
      last = await evaluateInDesk(id, projectOnboardScript(name, { create: true }), 28000, { targetId });
      if (last?.ok) return last;
    }
    await sleep(1500);
  }
  return last;
}

function kickOnboard(id, user, targetId) {
  const name = String(user.username || "").trim();
  if (!name) return;
  const uid = user.id;
  const create = !users.readyOn(uid, id);
  withOnboardLock(id, () => runOnboard(id, name, { create, targetId }))
    .then((r) => {
      if (r?.ok) users.update(uid, { projectReady: true, projectName: name, projectDesk: id });
    })
    .catch(() => {});
}

async function closeSeatTab(seat) {
  if (seat?.mode === "tab" && seat.targetId) {
    await closeTarget(seat.deskId, seat.targetId).catch(() => {});
  }
}

async function releaseUserSeats(userId) {
  const released = seats.releaseByUser(userId);
  await Promise.all(released.map((s) => closeSeatTab(s)));
  return released;
}

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: true });
proxy.on("proxyReq", (proxyReq) => {
  if (!VNC_PASSWORD) return;
  proxyReq.setHeader("Authorization", `Basic ${Buffer.from(`${VNC_USER}:${VNC_PASSWORD}`).toString("base64")}`);
});
proxy.on("proxyRes", (proxyRes) => {
  proxyRes.headers["permissions-policy"] = "clipboard-read=*, clipboard-write=*";
  delete proxyRes.headers["cross-origin-embedder-policy"];
  delete proxyRes.headers["cross-origin-opener-policy"];
  delete proxyRes.headers["cross-origin-resource-policy"];
});
proxy.on("error", (err, _req, res) => {
  console.error("proxy error:", err.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("暂时无法连接");
  }
});

function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const rec = readSession(sessions, parseCookie(req.headers.cookie)[COOKIE], Date.now(), TTL_MS);
  if (!rec) return null;
  const user = users.get(rec.userId);
  if (!user || user.disabled) return null;
  return { ...rec, user };
}

function clientIp(req) {
  // 经 Cloudflare Tunnel 时源地址是本机，真实来源在 CF-Connecting-IP；
  // 直连入口只在内网（BIND_ADDR 绑内网地址），伪造该头无利可图。
  return String(req.headers["cf-connecting-ip"] || req.socket?.remoteAddress || "unknown");
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  });
  res.end(JSON.stringify(body));
}

function setCookie(res, name, value, maxAge) {
  const prev = res.getHeader("set-cookie");
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  list.push(`${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
  res.setHeader("set-cookie", list);
}

const BODY_LIMIT = 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw new Error("body too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

const PANEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const full = join(WEB, file);
  if (!full.startsWith(WEB) || !existsSync(full)) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const headers = {
    "content-type": types[extname(full)] || "application/octet-stream",
    "cache-control": "no-store",
    "permissions-policy": "clipboard-read=*, clipboard-write=*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
  if (extname(full) === ".html" || pathname === "/") headers["content-security-policy"] = PANEL_CSP;
  res.writeHead(200, headers);
  res.end(readFileSync(full));
  return true;
}

async function handleApi(req, res, url, sess) {
  if (url.pathname === "/api/setup" && req.method === "GET") {
    return json(res, 200, { needed: !users.hasAdmin() });
  }
  if (url.pathname === "/api/setup" && req.method === "POST") {
    if (users.hasAdmin()) return json(res, 403, { error: "已完成初始化" });
    const body = await readBody(req);
    try {
      const user = users.createAdmin({ username: body.username, password: body.password });
      const token = createSessionToken();
      sessions.set(token, { userId: user.id, expires: Date.now() + TTL_MS });
      setCookie(res, COOKIE, token, Math.floor(TTL_MS / 1000));
      console.log(`setup: admin ${user.username} created ip=${clientIp(req)}`);
      return json(res, 200, { user });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    const ip = clientIp(req);
    const key = `${ip}|${String(body.username || "").trim().slice(0, 64)}`;
    if (loginLimiter.blocked(key)) {
      console.warn(`login blocked (rate limit) user=${body.username} ip=${ip}`);
      return json(res, 429, { error: "尝试次数过多，请 15 分钟后再试" });
    }
    const user = users.login(body.username, body.password);
    if (!user) {
      loginLimiter.fail(key);
      console.warn(`login fail user=${body.username} ip=${ip}`);
      return json(res, 401, { error: "用户名或密码错误" });
    }
    loginLimiter.ok(key);
    console.log(`login ok user=${user.username} ip=${ip}`);
    const token = createSessionToken();
    sessions.set(token, { userId: user.id, expires: Date.now() + TTL_MS });
    setCookie(res, COOKIE, token, Math.floor(TTL_MS / 1000));
    return json(res, 200, { user });
  }
  if (url.pathname === "/api/logout" && req.method === "POST") {
    const token = parseCookie(req.headers.cookie)[COOKIE];
    if (token) sessions.delete(token);
    setCookie(res, COOKIE, "", 0);
    setCookie(res, DESK, "", 0);
    return json(res, 200, { ok: true });
  }
  if (!sess) return json(res, 401, { error: "未登录" });
  if (url.pathname === "/api/me") return json(res, 200, { user: sess.user, settings: users.settings() });
  if (url.pathname === "/api/settings" && req.method === "GET") return json(res, 200, { settings: users.settings() });
  if (url.pathname === "/api/admin/settings" && req.method === "POST") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    const body = await readBody(req);
    return json(res, 200, { settings: users.setSettings(body) });
  }
  if (url.pathname === "/api/desks") {
    const isAdmin = sess.user.role === "admin";
    const desks = registry
      .all()
      .filter((d) => users.canOpen(sess.user, d.id))
      .map((d) => ({
        id: d.id,
        name: users.deskNameOf(d.id) || d.name,
        ...(isAdmin ? { proxy: users.deskProxyOf(d.id), extra: users.isExtraDesk(d.id) } : {}),
      }));
    return json(res, 200, { desks, ...(isAdmin ? { proxyPresets: users.proxyPresets() } : {}) });
  }
  if (url.pathname === "/api/admin/desks" && req.method === "POST") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    const body = await readBody(req);
    try {
      const desk = await provisionDesk({
        users,
        registry,
        name: body.name,
        id: body.id,
        ensure: (id) => ensureDeskContainer(id, docker),
      });
      console.log(`desk added id=${desk.id} name=${desk.name} by=${sess.user.username} ip=${clientIp(req)}`);
      return json(res, 200, { desk });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
  }
  const rename = url.pathname.match(/^\/api\/admin\/desks\/([a-z0-9-]+)$/);
  if (rename && req.method === "DELETE") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    const id = rename[1];
    try {
      for (const v of presence.list(id)) {
        if (v.id) kickLiveSession({ sessions, presence, sockets: liveSockets, seats }, v.id);
      }
      const parked = seats.releaseDesk(id);
      await Promise.all(parked.map((s) => closeSeatTab(s)));
      presence.clear(id);
      const desk = await retireDesk({
        users,
        registry,
        id,
        remove: (deskId) => removeDeskContainer(deskId, docker),
      });
      console.log(`desk removed id=${desk.id} by=${sess.user.username} ip=${clientIp(req)}`);
      return json(res, 200, { ok: true, desk });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
  }
  if (rename && req.method === "PATCH") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    if (!registry.has(rename[1])) return json(res, 404, { error: "账号不存在" });
    try {
      const body = await readBody(req);
      const out = { ok: true };
      if ("name" in body) out.name = users.renameDesk(rename[1], body.name) || registry.get(rename[1]).name;
      if ("proxy" in body) {
        const proxy = users.setDeskProxy(rename[1], body.proxy);
        try {
          await applyDeskProxyLive(rename[1], proxy);
        } catch {
          return json(res, 502, { error: "代理已保存，但账号容器暂时不可达，重启该容器后生效" });
        }
        out.proxy = proxy;
      }
      return json(res, 200, out);
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (url.pathname === "/api/admin/proxies" && req.method === "POST") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    try {
      const body = await readBody(req);
      const proxy = users.setAllDeskProxies(body.proxy);
      const ids = registry.ids();
      const { failed } = await applyDeskProxiesLive(ids, proxy);
      if (failed.length) {
        return json(res, 502, {
          error: failed.length === ids.length
            ? "代理已保存，但账号容器暂时不可达，重启这些容器后生效"
            : "代理已保存，但部分账号容器暂时不可达，重启这些容器后生效",
          proxy,
          failed,
        });
      }
      return json(res, 200, { ok: true, proxy, desks: ids.length });
    } catch (e) {
      return json(res, e.status || 400, { error: e.message });
    }
  }
  if (url.pathname === "/api/presence") {
    const all = presence.all();
    if (sess.user.role === "admin") return json(res, 200, { presence: all });
    const mine = {};
    for (const d of registry.all()) {
      if (users.canOpen(sess.user, d.id) && all[d.id]) mine[d.id] = all[d.id];
    }
    return json(res, 200, { presence: mine });
  }
  if (url.pathname === "/api/presence/beat" && req.method === "POST") {
    const body = await readBody(req);
    const deskId = String(body.deskId || parseCookie(req.headers.cookie)[DESK] || "");
    if (!users.canOpen(sess.user, deskId)) return json(res, 403, { error: "没有访问权限" });
    const seat = seats.ofUser(deskId, sess.user.id);
    if (seat) seats.beat(seat.id);
    return json(res, 200, { viewers: presence.beat(deskId, sess.user), seat: publicSeat(seat) });
  }
  if (url.pathname === "/api/presence/leave" && req.method === "POST") {
    await releaseUserSeats(sess.user.id);
    presence.leaveAll(sess.user.id);
    return json(res, 200, { ok: true, presence: presence.all() });
  }
  const open = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/open$/);
  if (open && req.method === "POST") {
    const id = open[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    let hasSession = false;
    try {
      hasSession = await deskHasChatGPTSession(id);
    } catch {
      hasSession = false;
    }
    let decision;
    try {
      decision = seats.decide(id, sess.user, { hasSession });
    } catch (e) {
      return json(res, e.status || 409, { error: e.message, cap: seats.cap });
    }
    let seat;
    if (decision.attach) {
      seat = decision.seat || seats.ofUser(id, sess.user.id);
      if (seat?.mode === "tab") {
        const alive = await targetExists(id, seat.targetId);
        if (!alive) {
          try {
            const created = await createParkedChatGPTTab(id);
            seat = seats.claim(id, sess.user, { mode: "tab", targetId: created.targetId });
          } catch (e) {
            return json(res, 502, { error: e.message || "无法创建分屏席位，请稍后再试" });
          }
        } else {
          seats.beat(seat.id);
        }
      } else {
        seats.beat(seat.id);
      }
    } else if (decision.mode === "tab") {
      let created;
      try {
        created = await createParkedChatGPTTab(id);
      } catch (e) {
        return json(res, 502, { error: e.message || "无法创建分屏席位，请稍后再试" });
      }
      try {
        seat = seats.claim(id, sess.user, { mode: "tab", targetId: created.targetId });
      } catch (e) {
        await closeTarget(id, created.targetId).catch(() => {});
        return json(res, e.status || 409, { error: e.message, cap: seats.cap });
      }
    } else {
      seat = seats.claim(id, sess.user, { mode: "vnc" });
    }
    setCookie(res, DESK, id, Math.floor(TTL_MS / 1000));
    presence.beat(id, sess.user);
    if (users.assistOn()) kickOnboard(id, sess.user, seat?.targetId);
    return json(res, 200, { ok: true, id, mode: seat.mode, seat: publicSeat(seat), cap: seats.cap });
  }
  const paste = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/paste$/);
  if (paste && req.method === "POST") {
    const id = paste[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    if (!body.length) return json(res, 400, { error: "空内容" });
    if (body.length > 8 * 1024 * 1024) return json(res, 413, { error: "太大了" });
    const ct = String(req.headers["content-type"] || "text/plain; charset=utf-8");
    const tab = seats.ofUser(id, sess.user.id);
    if (tab?.mode === "tab") {
      if (!ct.startsWith("text/")) return json(res, 400, { error: "分屏席位暂不支持粘贴图片" });
      try {
        const text = body.toString("utf8");
        const attached = await attachSeatTarget(id, tab.targetId);
        try {
          await attached.cdp.send("Input.insertText", { text: text.slice(0, 64 * 1024) }, attached.sessionId);
        } finally {
          attached.cdp.close();
        }
        return json(res, 200, { ok: true, scoped: "tab" });
      } catch {
        return json(res, 502, { error: "无法粘贴" });
      }
    }
    try {
      const r = await fetch(`http://desktop-${id}:18790/`, {
        method: "POST",
        headers: { "content-type": ct, "content-length": String(body.length) },
        body,
      });
      if (!r.ok) return json(res, 502, { error: "无法粘贴" });
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 502, { error: "无法粘贴" });
    }
  }
  const copy = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/copy$/);
  if (copy && req.method === "POST") {
    const id = copy[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    const tab = seats.ofUser(id, sess.user.id);
    if (tab?.mode === "tab") {
      try {
        const text = await evaluateOnTarget(id, tab.targetId, TAB_CLIP_READ);
        const buf = Buffer.from(String(text || ""), "utf8");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(buf);
        return;
      } catch {
        return json(res, 502, { error: "无法复制" });
      }
    }
    try {
      const r = await fetch(`http://desktop-${id}:18790/grab`, { method: "POST" });
      if (!r.ok) return json(res, 502, { error: "无法复制" });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get("content-type") || "text/plain; charset=utf-8";
      res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
      res.end(buf);
      return;
    } catch {
      return json(res, 502, { error: "无法复制" });
    }
  }
  const peek = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/peek$/);
  if (peek && req.method === "GET") {
    const id = peek[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    const tab = seats.ofUser(id, sess.user.id);
    if (tab?.mode === "tab") {
      try {
        const text = await evaluateOnTarget(id, tab.targetId, TAB_CLIP_READ);
        const buf = Buffer.from(String(text || ""), "utf8");
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end(buf);
        return;
      } catch {
        return json(res, 502, { error: "无法读取剪贴板" });
      }
    }
    try {
      const { ct, buf } = await peekClipboard(id);
      res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
      res.end(buf);
      return;
    } catch {
      return json(res, 502, { error: "无法读取剪贴板" });
    }
  }
  const share = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/share$/);
  if (share && req.method === "POST") {
    const id = share[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    if (!users.assistOn()) return json(res, 403, { error: "未开启页面协助" });
    try {
      const tab = seats.ofUser(id, sess.user.id);
      const clicked = await evaluateInDesk(id, SHARE_CLICK, 28000, { targetId: tab?.targetId });
      if (!clicked?.ok) return json(res, 400, { error: clicked?.error || "分享失败" });
      await sleep(400);
      let text = "";
      if (tab?.mode === "tab" && tab.targetId) {
        text = String((await evaluateOnTarget(id, tab.targetId, TAB_CLIP_READ)) || "").trim();
      } else {
        const { buf } = await peekClipboard(id);
        text = buf.toString("utf8").trim();
      }
      if (!isShareUrl(text)) return json(res, 200, { ok: true, url: "" });
      return json(res, 200, { ok: true, url: text.split(/\s+/)[0] });
    } catch (e) {
      return json(res, 502, { error: e.message || "分享失败" });
    }
  }
  const onboard = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/onboard$/);
  if (onboard && req.method === "POST") {
    const id = onboard[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    if (!users.assistOn()) return json(res, 403, { error: "未开启页面协助" });
    const name = String(sess.user.username || "").trim();
    if (!name) return json(res, 400, { error: "没有用户名" });
    try {
      const create = !users.readyOn(sess.user.id, id);
      const tab = seats.ofUser(id, sess.user.id);
      const r = await withOnboardLock(id, () => runOnboard(id, name, { create, targetId: tab?.targetId }));
      if (!r?.ok) return json(res, 400, { error: r?.error || "工作区还没准备好" });
      users.update(sess.user.id, { projectReady: true, projectName: name, projectDesk: id });
      return json(res, 200, { ok: true, name, action: r.action || "opened", created: r.action === "created" });
    } catch (e) {
      const raw = e.message || "";
      const error = /chromium|ChatGPT 页面|无法连接|未就绪/i.test(raw) ? "工作区还没准备好" : raw || "工作区还没准备好";
      return json(res, 502, { error });
    }
  }
  if (url.pathname === "/api/admin/users" && req.method === "GET") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    return json(res, 200, { users: users.list() });
  }
  if (url.pathname === "/api/admin/users" && req.method === "POST") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    try {
      const body = await readBody(req);
      return json(res, 200, { user: users.create(body) });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  const kick = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/kick$/);
  if (kick && req.method === "POST") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    const user = users.get(kick[1]);
    if (!user) return json(res, 404, { error: "用户不存在" });
    const dropped = kickLiveSession({ sessions, presence, sockets: liveSockets, seats }, kick[1]);
    await Promise.all((dropped.released || []).map((s) => closeSeatTab(s)));
    console.log(`kick user=${user.username} by=${sess.user.username} sessions=${dropped.sessions} sockets=${dropped.sockets} ip=${clientIp(req)}`);
    return json(res, 200, { ok: true, user, ...dropped, presence: presence.all() });
  }
  const one = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (one && req.method === "PATCH") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    try {
      const body = await readBody(req);
      const patch = {};
      if (Array.isArray(body.desks)) patch.desks = body.desks;
      if (body.password) patch.password = String(body.password);
      if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
      const user = users.update(one[1], patch);
      if (body.password || body.disabled === true) sessions.deleteByUser(one[1]);
      if (body.disabled === true) {
        presence.leaveAll(one[1]);
        await releaseUserSeats(one[1]);
      }
      return json(res, 200, { user });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  if (one && req.method === "DELETE") {
    if (sess.user.role !== "admin") return json(res, 403, { error: "没有权限" });
    try {
      users.remove(one[1]);
      sessions.deleteByUser(one[1]);
      presence.leaveAll(one[1]);
      await releaseUserSeats(one[1]);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }
  return json(res, 404, { error: "not found" });
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  const sess = getSession(req);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url, sess);
    return;
  }
  if (url.pathname === "/" || url.pathname === "/app.css" || url.pathname === "/app.js") {
    if (serveStatic(res, url.pathname === "/" ? "/" : url.pathname)) return;
  }
  if (!sess) {
    if ((req.headers.upgrade || "").toLowerCase() === "websocket") {
      res.writeHead(401);
      res.end();
      return;
    }
    if (url.pathname === "/" || url.pathname.startsWith("/app")) {
      serveStatic(res, "/");
      return;
    }
    res.writeHead(302, { location: "/" });
    res.end();
    return;
  }
  const deskId = parseCookie(req.headers.cookie)[DESK];
  const desk = deskId && registry.get(deskId);
  if (!desk || !users.canOpen(sess.user, desk.id)) {
    if (serveStatic(res, "/")) return;
    json(res, 403, { error: "请先选择账号" });
    return;
  }
  proxy.web(req, res, { target: desk.target });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err?.message === "body too large") {
      if (!res.headersSent) json(res, 413, { error: "请求体太大" });
      return;
    }
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  });
});

server.on("upgrade", (req, socket, head) => {
  const sess = getSession(req);
  if (!sess) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const seatMatch = url.pathname.match(/^\/seats\/([0-9a-f-]{36})$/i);
  if (seatMatch) {
    const seat = seats.get(seatMatch[1]);
    if (!seat || seat.userId !== sess.user.id || seat.mode !== "tab" || !users.canOpen(sess.user, seat.deskId)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    seatWss.handleUpgrade(req, socket, head, (ws) => {
      liveSockets.add(sess.user.id, ws);
      seats.beat(seat.id);
      startSeatScreencast({ ws, seat }).catch((err) => {
        console.error("seat stream:", err.message);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      });
    });
    return;
  }
  const deskId = parseCookie(req.headers.cookie)[DESK];
  const desk = deskId && registry.get(deskId);
  if (!desk || !users.canOpen(sess.user, desk.id)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  if (VNC_PASSWORD) {
    req.headers.authorization = `Basic ${Buffer.from(`${VNC_USER}:${VNC_PASSWORD}`).toString("base64")}`;
  }
  liveSockets.add(sess.user.id, socket);
  proxy.ws(req, socket, head, { target: desk.target });
});

async function reconcileExtraDesks() {
  const extras = users.extraDeskIds();
  if (!extras.length) return;
  for (const id of extras) {
    try {
      await ensureDeskContainer(id, docker);
      console.log(`desk ${id}: container ready`);
    } catch (e) {
      console.error(`desk ${id}: ${e.message}`);
    }
  }
}

setInterval(() => {
  for (const seat of seats.idleTabs()) {
    seats.release(seat.id);
    presence.leave(seat.deskId, seat.userId);
    closeSeatTab(seat).catch(() => {});
    console.log(`seat idle closed desk=${seat.deskId} user=${seat.username}`);
  }
}, 15_000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway on :${PORT} desks=${registry.ids().join(",")} tabSeats=${seats.cap}`);
  reconcileExtraDesks();
});
