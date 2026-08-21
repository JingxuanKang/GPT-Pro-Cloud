import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
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
import { evaluateInDesk, waitForDesk, peekClipboard, isShareUrl, SHARE_CLICK, TAB_CLIP_READ, READ_PROJECT_URL, projectOnboardScript, listSeatProjectLinks, sleep } from "../lib/chrome.mjs";
import { applyDeskProxyLive, applyDeskProxiesLive } from "../lib/proxy.mjs";
import { createSeatRegistry, parseTabSeatCap, publicSeat, seatOpenFlags } from "../lib/seats.mjs";
import { applyDeskCdpLive, attachSeatTarget, closeTarget, createParkedChatGPTTab, deskHasChatGPTSession, evaluateOnTarget, forgetDeskBrowser, listDeskTargets, parkSeatTarget, targetExists, withDeadline } from "../lib/cdp.mjs";
import { createSeatJailRegistry, navigateSeatToUrl, pickNamedProjectHref, pickTargetForProject, projectUrlFromOnboard, seatStartUrl } from "../lib/project-jail.mjs";
import {
  CHATGPT_NOT_LOGGED_IN,
  DESK_UNREACHABLE,
  WORKSPACE_NOT_READY,
  acceptOnboardResult,
  assignDesksWithProjects,
  exclusiveOccupied,
  removedDesks,
  lockMemberToStoredProject,
  memberOpenDecision,
  renameMemberWithProjects,
  runEnableJob,
} from "../lib/split-screen.mjs";
import { startSeatScreencast } from "../lib/screencast.mjs";
import { applyTabPastePlan, tabPastePlan } from "../lib/tab-paste.mjs";
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
const jails = createSeatJailRegistry();
const sessions = createSessionStore({ file: join(dirname(USERS_FILE), "sessions.json"), ttlMs: TTL_MS });
const liveSockets = createSocketHub();
const seatWss = new WebSocketServer({ noServer: true });
const loginLimiter = createLoginLimiter({ maxFails: 10, windowMs: 15 * 60 * 1000 });
const deskCdpLocks = new Map();
const CLOSE_SEAT_MS = 2000;
const DOCKER_DELETE_MS = 8_000;

async function withDeskCdp(id, fn) {
  const prev = deskCdpLocks.get(id) || Promise.resolve();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  deskCdpLocks.set(
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

async function rememberProjectUrl(uid, deskId, name, raw) {
  const url = projectUrlFromOnboard({ url: raw });
  const patch = { projectReady: true, projectName: name, projectDesk: deskId };
  if (url) patch.projectUrl = url;
  users.update(uid, patch);
  return url || users.projectUrlOn(uid, deskId);
}

async function resolveOnboardUrl(id, result, targetId) {
  const fromResult = projectUrlFromOnboard(result);
  if (fromResult) return fromResult;
  try {
    const href = await evaluateInDesk(id, READ_PROJECT_URL, 8000, { targetId });
    return projectUrlFromOnboard({ url: href });
  } catch {
    return "";
  }
}

async function armSeatProjectJail(seat, home) {
  if (!seat?.id || !home) return;
  seat.projectUrl = home;
  try {
    await jails.arm(seat, home);
  } catch {
    /* jail is best-effort — page assist still ran */
  }
}

async function runOnboard(id, name, { create = true, targetId } = {}) {
  await waitForDesk(id, 45000, { targetId });
  let last = { ok: false, error: "工作区还没准备好" };
  for (let i = 0; i < 3; i++) {
    last = await withDeskCdp(id, () => evaluateInDesk(id, projectOnboardScript(name, { create }), 28000, { targetId }));
    if (last?.ok) return last;
    await sleep(1500);
  }
  return last;
}

async function findParkedProjectTarget(deskId, projectUrl, claimedTargetIds = []) {
  if (!projectUrl) return null;
  try {
    const pages = await listDeskTargets(deskId);
    return pickTargetForProject(pages, { projectUrl, claimedTargetIds });
  } catch {
    return null;
  }
}

async function ensureParkedMemberSeat(deskId, user, projectUrl) {
  if (!user?.id || user.role === "admin" || !projectUrl) return null;
  const existing = seats.ofUser(deskId, user.id);
  if (existing?.mode === "tab" && existing.targetId && (await targetExists(deskId, existing.targetId))) {
    return existing;
  }
  const claimedTargetIds = seats.list(deskId).map((s) => s.targetId).filter(Boolean);
  const found = await findParkedProjectTarget(deskId, projectUrl, claimedTargetIds);
  if (found?.id) {
    return seats.claim(deskId, user, { mode: "tab", targetId: found.id, projectUrl });
  }
  const startUrl = seatStartUrl({ cdp: true, projectUrl });
  const created = await createParkedChatGPTTab(deskId, { claimedTargetIds, startUrl });
  return seats.claim(deskId, user, { mode: "tab", targetId: created.targetId, projectUrl });
}

async function warmDeskMemberSeats(deskId) {
  if (!users.deskCdpOn(deskId)) return;
  for (const member of users.assignedMembers(deskId)) {
    const url = users.projectUrlOn(member.id, deskId);
    if (!url) continue;
    try {
      await ensureParkedMemberSeat(deskId, member, url);
    } catch (e) {
      console.error(`warm seat desk=${deskId} user=${member.username}: ${e.message}`);
    }
  }
}

async function warmAllParkedMemberSeats() {
  for (const id of registry.ids()) {
    await warmDeskMemberSeats(id);
  }
}

async function forgetDeskTabSeats(deskId) {
  for (const seat of seats.list(deskId).filter((s) => s.mode === "tab")) {
    seats.release(seat.id);
    await closeSeatTab(seat).catch(() => {});
  }
}

/** Job-only: parked tab, require project-only memory, persist URL. Never used on member open. Keep the window. */
async function createMemberProject(deskId, user, { skipIfUrl = true, name } = {}) {
  const projectName = String(name || user?.username || "").trim();
  const uid = user?.id;
  if (!projectName || !uid) return { ok: false, error: "没有用户名" };
  if (skipIfUrl) {
    const existing = users.projectUrlOn(uid, deskId);
    if (existing) {
      try {
        await ensureParkedMemberSeat(deskId, user, existing);
      } catch {
        /* URL is enough for assign; warm retries on boot / next enable */
      }
      return { ok: true, url: existing, skipped: true, memory: "project-only" };
    }
  }
  const claimedTargetIds = seats.list(deskId).map((s) => s.targetId).filter(Boolean);
  let created;
  try {
    created = await createParkedChatGPTTab(deskId, { claimedTargetIds });
  } catch (e) {
    return { ok: false, error: e.message || "无法创建分屏席位，请稍后再试" };
  }
  try {
    const r = await runOnboard(deskId, projectName, { create: true, targetId: created.targetId });
    let accepted = acceptOnboardResult(r);
    if (!accepted.ok && r?.ok) {
      const resolved = await resolveOnboardUrl(deskId, r, created.targetId);
      accepted = acceptOnboardResult({ ...r, url: resolved || r.url });
    }
    if (!accepted.ok) {
      // closeTarget refuses the last/primary page so onboard cannot kill Chromium.
      await closeTarget(deskId, created.targetId).catch(() => {});
      return accepted;
    }
    await rememberProjectUrl(uid, deskId, projectName, accepted.url);
    seats.claim(deskId, user, { mode: "tab", targetId: created.targetId, projectUrl: accepted.url });
    return { ok: true, url: accepted.url, action: accepted.action, memory: "project-only" };
  } catch (e) {
    await closeTarget(deskId, created.targetId).catch(() => {});
    return { ok: false, error: e.message || "无法创建分屏席位，请稍后再试" };
  }
}

/**
 * Member path only: navigate to the stored project URL and arm the jail.
 * Do not create a ChatGPT project here.
 */
async function lockSeatToProject(id, user, targetId) {
  if (user?.role === "admin") return { ok: true, action: "admin" };
  const locked = lockMemberToStoredProject({ user, deskId: id, users });
  if (!locked.ok) return locked;
  const home = locked.url;
  const seat = seats.ofUser(id, user.id);
  if (targetId) {
    await withDeskCdp(id, () => navigateSeatToUrl(id, targetId, home)).catch(() => {});
  }
  if (seat) await armSeatProjectJail(seat, home);
  return { ok: true, url: home, action: "opened", created: false };
}

async function applyCdpPort(deskId, on) {
  await applyDeskCdpLive(deskId, on);
  forgetDeskBrowser(deskId);
}

async function enableDeskSplitScreen(deskId) {
  const job = await runEnableJob({
    deskId,
    users,
    occupied: exclusiveOccupied({ seats, presence, deskId }),
    alreadyOn: users.deskCdpOn(deskId),
    applyCdp: (on) => applyCdpPort(deskId, on),
    persistCdp: (on) => users.setDeskCdp(deskId, on),
    waitForDebugger: (id) => waitForDesk(id, 45_000),
    hasSession: () => deskHasChatGPTSession(deskId),
    createProject: (id, member) => createMemberProject(id, member),
  });
  if (job.ok) await warmDeskMemberSeats(deskId);
  else await forgetDeskTabSeats(deskId);
  return job;
}

async function disableDeskSplitScreen(deskId) {
  if (!users.deskCdpOn(deskId)) return { ok: true, cdp: false };
  const parked = seats.list(deskId).filter((s) => s.mode === "tab");
  for (const seat of parked) {
    seats.release(seat.id);
    await closeSeatTab(seat).catch(() => {});
  }
  users.setDeskCdp(deskId, false);
  try {
    await applyCdpPort(deskId, false);
  } catch {
    return { ok: false, status: 502, error: DESK_UNREACHABLE, cdp: false };
  }
  return { ok: true, cdp: false };
}

async function closeSeatTab(seat) {
  if (seat?.id) jails.stop(seat.id);
  if (seat?.mode === "tab" && seat.targetId) {
    await withDeadline(closeTarget(seat.deskId, seat.targetId), CLOSE_SEAT_MS, "关闭分屏窗口超时").catch(() => {});
  }
}

async function releaseUserSeats(userId) {
  const released = seats.releaseByUser(userId);
  await Promise.all(released.map((s) => closeSeatTab(s)));
  return released;
}

async function parkUserSeatWindows(userId) {
  const held = seats.ofUserAll(userId);
  const parked = [];
  for (const seat of held) {
    if (seat.mode === "tab" && seat.targetId) {
      await parkSeatTarget(seat.deskId, seat.targetId).catch(() => {});
      parked.push(seat);
    } else {
      seats.release(seat.id);
    }
  }
  return parked;
}

async function closeUnassignedSeatTabs(userId, prevDesks, nextDesks) {
  for (const deskId of removedDesks(prevDesks, nextDesks)) {
    const seat = seats.ofUser(deskId, userId);
    if (!seat) continue;
    seats.release(seat.id);
    await closeSeatTab(seat).catch(() => {});
  }
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

function assetQuery(name) {
  try {
    return `v=${Math.floor(statSync(join(WEB, name)).mtimeMs)}`;
  } catch {
    return "v=1";
  }
}

function serveStatic(res, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const full = join(WEB, file);
  if (!full.startsWith(WEB) || !existsSync(full)) return false;
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
  const headers = {
    "content-type": types[extname(full)] || "application/octet-stream",
    "cache-control": "no-store, no-cache, must-revalidate",
    pragma: "no-cache",
    "permissions-policy": "clipboard-read=*, clipboard-write=*",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
  if (extname(full) === ".html" || pathname === "/") headers["content-security-policy"] = PANEL_CSP;
  let body = readFileSync(full);
  if (file === "index.html") {
    body = Buffer.from(
      body
        .toString("utf8")
        .replace(/href="\/app\.css[^"]*"/, `href="/app.css?${assetQuery("app.css")}"`)
        .replace(/src="\/app\.js[^"]*"/, `src="/app.js?${assetQuery("app.js")}"`),
    );
  }
  res.writeHead(200, headers);
  res.end(body);
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
        cdp: users.deskCdpOn(d.id),
        ...(isAdmin ? { proxy: users.deskProxyOf(d.id), extra: users.isExtraDesk(d.id) } : {}),
      }));
    return json(res, 200, { desks, seatCap: seats.cap, ...(isAdmin ? { proxyPresets: users.proxyPresets() } : {}) });
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
        ensure: (id) => ensureDeskContainer(id, docker, { enableCdp: users.deskCdpOn(id) }),
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
      const leftovers = [];
      for (const v of presence.list(id)) {
        if (!v.id) continue;
        const dropped = kickLiveSession({ sessions, presence, sockets: liveSockets, seats }, v.id);
        leftovers.push(...(dropped.released || []));
      }
      leftovers.push(...seats.releaseDesk(id));
      await Promise.all(leftovers.map((s) => closeSeatTab(s)));
      presence.clear(id);
      const desk = await retireDesk({
        users,
        registry,
        id,
        remove: (deskId) =>
          withDeadline(removeDeskContainer(deskId, docker), DOCKER_DELETE_MS, "拆除账号容器超时，请稍后重试"),
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
      if ("cdp" in body) {
        const want = !!body.cdp;
        if (!want) {
          const off = await disableDeskSplitScreen(rename[1]);
          if (!off.ok) return json(res, off.status || 502, { error: off.error });
          out.cdp = false;
        } else {
          const job = await enableDeskSplitScreen(rename[1]);
          if (!job.ok) return json(res, job.status || 400, { error: job.error, cdp: false });
          out.cdp = true;
        }
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
    await parkUserSeatWindows(sess.user.id);
    presence.leaveAll(sess.user.id);
    return json(res, 200, { ok: true, presence: presence.all() });
  }
  const open = url.pathname.match(/^\/api\/desks\/([a-z0-9-]+)\/open$/);
  if (open && req.method === "POST") {
    const id = open[1];
    if (!users.canOpen(sess.user, id) || !registry.has(id)) return json(res, 403, { error: "没有访问权限" });
    const cdp = users.deskCdpOn(id);
    const extraOccupants = presence.list(id).map((v) => ({ userId: v.id }));
    const storedUrl = cdp && sess.user.role !== "admin" ? users.projectUrlOn(sess.user.id, id) : "";
    if (cdp && sess.user.role !== "admin") {
      let hasSession = null;
      try {
        hasSession = await deskHasChatGPTSession(id);
      } catch {
        hasSession = null;
      }
      const gate = memberOpenDecision({
        cdp,
        role: sess.user.role,
        projectUrl: storedUrl,
        hasSession,
      });
      if (!gate.ok) {
        return json(res, gate.status || 409, {
          error: gate.error || "该账号尚未登录 ChatGPT",
          code: gate.code,
        });
      }
    }
    let decision;
    try {
      decision = seats.decide(id, sess.user, { cdp, extraOccupants });
    } catch (e) {
      return json(res, e.status || 409, { error: e.message, cap: seats.cap, code: e.code });
    }
    const claimedTargetIds = seats.list(id).map((s) => s.targetId).filter(Boolean);
    const projectUrl = sess.user.role === "admin" ? "" : storedUrl;
    const startUrl = seatStartUrl({ cdp: cdp && sess.user.role !== "admin", projectUrl });
    let seat;
    let reused = false;
    if (decision.attach) {
      seat = decision.seat || seats.ofUser(id, sess.user.id);
      if (seat?.mode === "tab") {
        const alive = await targetExists(id, seat.targetId);
        if (alive) {
          seats.claim(id, sess.user, { projectUrl });
          seats.beat(seat.id);
          reused = true;
        } else {
          try {
            const found = await findParkedProjectTarget(id, projectUrl, claimedTargetIds);
            if (found?.id) {
              seat = seats.claim(id, sess.user, { mode: "tab", targetId: found.id, projectUrl });
              reused = true;
            } else {
              const created = await createParkedChatGPTTab(id, { claimedTargetIds, startUrl });
              seat = seats.claim(id, sess.user, { mode: "tab", targetId: created.targetId, projectUrl });
            }
          } catch (e) {
            return json(res, 502, { error: e.message || "无法创建分屏席位，请稍后再试" });
          }
        }
      } else {
        seats.beat(seat.id);
      }
    } else if (decision.mode === "tab") {
      try {
        const found = await findParkedProjectTarget(id, projectUrl, claimedTargetIds);
        if (found?.id) {
          seat = seats.claim(id, sess.user, { mode: "tab", targetId: found.id, projectUrl });
          reused = true;
        } else {
          const created = await createParkedChatGPTTab(id, { claimedTargetIds, startUrl });
          try {
            seat = seats.claim(id, sess.user, { mode: "tab", targetId: created.targetId, projectUrl });
          } catch (e) {
            await closeTarget(id, created.targetId).catch(() => {});
            return json(res, e.status || 409, { error: e.message, cap: seats.cap });
          }
        }
      } catch (e) {
        return json(res, 502, { error: e.message || "无法创建分屏席位，请稍后再试" });
      }
    } else {
      seat = seats.claim(id, sess.user, { mode: "vnc" });
    }
    setCookie(res, DESK, id, Math.floor(TTL_MS / 1000));
    presence.beat(id, sess.user);
    if (cdp && sess.user.role !== "admin" && projectUrl) armSeatProjectJail(seat, projectUrl).catch(() => {});
    return json(res, 200, { ok: true, id, mode: seat.mode, seat: publicSeat(seat), cap: seats.cap, ...seatOpenFlags({ mode: seat.mode, reused }) });
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
      const plan = tabPastePlan(ct, body);
      if (plan.error) return json(res, plan.status || 400, { error: plan.error });
      try {
        const attached = await attachSeatTarget(id, tab.targetId);
        try {
          const out = await applyTabPastePlan(
            (method, params) => attached.cdp.send(method, params, attached.sessionId),
            plan,
          );
          if (!out.ok) return json(res, out.status || 400, { error: out.error || "无法粘贴" });
          return json(res, 200, { ok: true, scoped: "tab", kind: out.kind });
        } finally {
          await attached.release();
        }
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
    if (!users.deskCdpOn(id)) return json(res, 403, { error: "这个号未开多人分屏，页面协助需要开启调试口" });
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
    if (!users.deskCdpOn(id)) return json(res, 403, { error: "这个号未开多人分屏，页面协助需要开启调试口" });
    if (sess.user.role === "admin") return json(res, 200, { ok: true, name: sess.user.username, action: "admin", created: false, url: "" });
    const name = String(sess.user.username || "").trim();
    if (!name) return json(res, 400, { error: "没有用户名" });
    try {
      const tab = seats.ofUser(id, sess.user.id);
      const r = await lockSeatToProject(id, sess.user, tab?.targetId);
      if (!r?.ok) return json(res, 409, { error: r?.error || "工作区未就绪" });
      return json(res, 200, { ok: true, name, action: r.action || "opened", created: false, url: r.url || "" });
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
      const requested = Array.isArray(body.desks) ? body.desks : [];
      const offDesks = requested.filter((d) => !users.deskCdpOn(d));
      const user = users.create({ ...body, desks: offDesks });
      if (!requested.some((d) => users.deskCdpOn(d))) return json(res, 200, { user });
      const assigned = await assignDesksWithProjects({
        user,
        nextDesks: requested,
        users,
        hasSession: (deskId) => deskHasChatGPTSession(deskId),
        createProject: (deskId, member) => createMemberProject(deskId, member),
      });
      if (!assigned.ok) return json(res, assigned.status || 400, { error: assigned.error, user: assigned.user });
      return json(res, 200, { user: assigned.user });
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
      const current = users.get(one[1]);
      if (!current) throw new Error("用户不存在");
      if (body.username && String(body.username).trim() !== current.username) {
        const renamed = await renameMemberWithProjects({
          user: current,
          username: body.username,
          users,
          hasSession: (deskId) => deskHasChatGPTSession(deskId),
          createProject: (deskId, member, opts) => createMemberProject(deskId, member, opts),
        });
        if (!renamed.ok) return json(res, renamed.status || 400, { error: renamed.error });
      }
      if (Array.isArray(body.desks)) {
        const prevDesks = users.get(one[1])?.desks || [];
        const assigned = await assignDesksWithProjects({
          user: users.get(one[1]),
          nextDesks: body.desks,
          users,
          hasSession: (deskId) => deskHasChatGPTSession(deskId),
          createProject: (deskId, member) => createMemberProject(deskId, member),
        });
        await closeUnassignedSeatTabs(one[1], prevDesks, assigned.user?.desks || []);
        if (!assigned.ok) return json(res, assigned.status || 400, { error: assigned.error, user: assigned.user });
      }
      const patch = {};
      if (body.password) patch.password = String(body.password);
      if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
      const user = Object.keys(patch).length ? users.update(one[1], patch) : users.get(one[1]);
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
    const uid = one[1];
    try {
      await releaseUserSeats(uid);
    } catch {
      /* still remove the account */
    }
    presence.leaveAll(uid);
    sessions.deleteByUser(uid);
    try {
      users.remove(uid);
    } catch (e) {
      return json(res, e.status || 400, { error: e.message || "未能移除成员" });
    }
    return json(res, 200, { ok: true });
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
      await ensureDeskContainer(id, docker, { enableCdp: users.deskCdpOn(id) });
      console.log(`desk ${id}: container ready`);
    } catch (e) {
      console.error(`desk ${id}: ${e.message}`);
    }
  }
}

setInterval(() => {
  for (const seat of seats.idleTabs()) {
    presence.leave(seat.deskId, seat.userId);
  }
}, 15_000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`gateway on :${PORT} desks=${registry.ids().join(",")} tabSeats=${seats.cap}`);
  reconcileExtraDesks()
    .then(() => warmAllParkedMemberSeats())
    .catch((e) => console.error(`warm seats: ${e.message}`));
});
