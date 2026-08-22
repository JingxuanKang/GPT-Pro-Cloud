/**
 * 多人分屏 jobs: enable, assign-while-on, rename, member open.
 * Projects are created only here — never when a member opens a desk.
 */
import { canonicalizeProjectUrl } from "./project-jail.mjs";

export const CHATGPT_NOT_LOGGED_IN = "该账号尚未登录 ChatGPT";
export const WORKSPACE_NOT_READY = "工作区未就绪";
export const ENABLE_OCCUPIED = "请先断开当前占用后再开启多人分屏";
export const PROJECT_ONLY_REQUIRED = "无法将项目设为仅项目记忆";
export const EXISTING_DEFAULT_MEMORY = "已有同名项目使用账号默认记忆，请管理员在完整桌面中改为仅项目记忆";
export const MEMORY_UNCONFIRMED = "无法确认项目记忆范围，请管理员在完整桌面中检查";
export const CAPTCHA_BLOCKED = "遇到验证码，请管理员在完整桌面中完成验证后再试";
export const ONBOARD_TIMEOUT = "页面操作超时，请稍后重试";
export const UI_CHANGED = "页面结构已变化，无法创建项目";
export const SESSION_UNKNOWN = "无法确认 ChatGPT 登录状态，请稍后重试";
export const DESK_UNREACHABLE = "账号容器暂时不可达，重启该容器后再试";
export const SPLIT_SCREEN_DISABLED = true;
export const SPLIT_SCREEN_DISABLED_MSG = "多人分屏暂未开放";

/** clipd returns as soon as Chromium is killed; :9223 is not up yet. */
export const SESSION_PROBE_TIMEOUT_MS = 45_000;
export const SESSION_PROBE_INTERVAL_MS = 700;

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry until the probe is known (true/false). null means the debugger
 * was unreachable — keep waiting. Only still-null after a real timeout
 * is SESSION_UNKNOWN, not "not logged in".
 */
export async function waitForKnownSession(hasSession, deskId, {
  timeoutMs = SESSION_PROBE_TIMEOUT_MS,
  intervalMs = SESSION_PROBE_INTERVAL_MS,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  if (typeof hasSession !== "function") return null;
  const deadline = now() + timeoutMs;
  let session = null;
  for (;;) {
    try {
      session = await hasSession(deskId);
    } catch {
      session = null;
    }
    if (session === true || session === false) return session;
    if (now() >= deadline) return session;
    await sleep(intervalMs);
    if (now() >= deadline) return session;
  }
}

export function chatgptNotLoggedInError() {
  const e = new Error(CHATGPT_NOT_LOGGED_IN);
  e.code = "CHATGPT_LOGGED_OUT";
  e.status = 403;
  return e;
}

export function workspaceNotReadyError() {
  const e = new Error(WORKSPACE_NOT_READY);
  e.code = "PROJECT_NOT_READY";
  e.status = 409;
  return e;
}

export function enableOccupiedError() {
  const e = new Error(ENABLE_OCCUPIED);
  e.code = "ENABLE_OCCUPIED";
  e.status = 409;
  return e;
}

export function assignedMembers(users, deskId) {
  return (users.list?.() || [])
    .filter((u) => u && u.role !== "admin" && (u.desks || []).includes(deskId))
    .map((u) => u);
}

export function desksNeedingProject(user, users) {
  return (user?.desks || []).filter((id) => users.deskCdpOn(id));
}

export function exclusiveOccupied({ seats, presence, deskId } = {}) {
  const seated = seats?.list?.(deskId) || [];
  if (seated.some((s) => s && (s.mode === "vnc" || s.mode === "tab"))) return true;
  const people = presence?.list?.(deskId) || [];
  return people.length > 0;
}

/** Members never create a project. Missing URL or dropped ChatGPT session blocks them. */
export function memberOpenDecision({
  cdp = false,
  role = "member",
  projectUrl = "",
  hasSession = null,
} = {}) {
  if (role === "admin") return { ok: true, mode: "vnc" };
  if (!cdp) return { ok: true, mode: "vnc" };
  if (hasSession === false) {
    return { ok: false, status: 403, error: CHATGPT_NOT_LOGGED_IN, code: "CHATGPT_LOGGED_OUT" };
  }
  if (!canonicalizeProjectUrl(projectUrl)) {
    return { ok: false, status: 409, error: WORKSPACE_NOT_READY, code: "PROJECT_NOT_READY" };
  }
  return { ok: true, mode: "tab", projectUrl: canonicalizeProjectUrl(projectUrl) };
}

export function lockMemberToStoredProject({ user, deskId, users, createProject } = {}) {
  if (typeof createProject === "function") {
    /* member path must never call this */
  }
  const home = users?.projectUrlOn?.(user?.id, deskId) || "";
  const url = canonicalizeProjectUrl(home);
  if (!url) return { ok: false, error: WORKSPACE_NOT_READY, created: false };
  return { ok: true, url, action: "opened", created: false };
}

export function formalizeOnboardError(raw) {
  const err = String(raw || "").trim();
  if (!err) return UI_CHANGED;
  if (/captcha|hcaptcha|验证码|verification challenge/i.test(err)) return CAPTCHA_BLOCKED;
  if (/timeout|超时/i.test(err)) return ONBOARD_TIMEOUT;
  if (/尚未登录|not logged|sign in|log in/i.test(err)) return CHATGPT_NOT_LOGGED_IN;
  if (/默认记忆|账号记忆|default memory|account memory/i.test(err)) return EXISTING_DEFAULT_MEMORY;
  if (/仅项目|project-only|记忆范围/i.test(err)) return /确认/.test(err) ? MEMORY_UNCONFIRMED : PROJECT_ONLY_REQUIRED;
  if (/New project|创建框|创建按钮|页面结构|找不到/i.test(err)) return err.length < 40 ? err : UI_CHANGED;
  return err;
}

export function acceptOnboardResult(result) {
  if (!result?.ok) return { ok: false, error: formalizeOnboardError(result?.error) };
  const memory = String(result.memory || "").toLowerCase();
  if (memory === "default" || memory === "account") {
    return { ok: false, error: EXISTING_DEFAULT_MEMORY };
  }
  if (memory !== "project-only") {
    return { ok: false, error: PROJECT_ONLY_REQUIRED };
  }
  const url = canonicalizeProjectUrl(result.url || result.href || "");
  if (!url) return { ok: false, error: WORKSPACE_NOT_READY };
  return { ok: true, url, action: result.action || "opened", memory: "project-only" };
}

export function formatMemberFailures(failures) {
  const list = (failures || []).filter((f) => f && f.error);
  if (!list.length) return UI_CHANGED;
  if (list.length === 1) {
    const one = list[0];
    return one.username ? `无法为 ${one.username} 准备项目：${one.error}` : one.error;
  }
  return list.map((f) => `${f.username}：${f.error}`).join("；");
}

export function addedDesks(prev, next) {
  const have = new Set(prev || []);
  return (next || []).filter((id) => !have.has(id));
}

export function removedDesks(prev, next) {
  const keep = new Set(next || []);
  return (prev || []).filter((id) => !keep.has(id));
}

/**
 * Enable job. Split-screen is withdrawn — this never turns CDP on.
 */
export async function runEnableJob({
  deskId,
  users,
  occupied = false,
  alreadyOn = false,
  applyCdp,
  persistCdp,
  hasSession,
  createProject,
  waitForDebugger,
  sessionProbeTimeoutMs = SESSION_PROBE_TIMEOUT_MS,
  sessionProbeIntervalMs = SESSION_PROBE_INTERVAL_MS,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  if (SPLIT_SCREEN_DISABLED) return { ok: false, status: 409, error: SPLIT_SCREEN_DISABLED_MSG, cdp: false };
  if (alreadyOn || users?.deskCdpOn?.(deskId)) return { ok: true, cdp: true, skipped: true };
  if (occupied) return { ok: false, status: 409, error: ENABLE_OCCUPIED, cdp: false };

  if (typeof applyCdp === "function") {
    try {
      await applyCdp(true);
    } catch {
      return { ok: false, status: 502, error: DESK_UNREACHABLE, cdp: false };
    }
  }

  const revert = async () => {
    if (typeof applyCdp === "function") {
      try {
        await applyCdp(false);
      } catch {
        /* leave Chromium as-is; flag stays off */
      }
    }
  };

  if (typeof waitForDebugger === "function") {
    try {
      await waitForDebugger(deskId);
    } catch {
      /* debugger still coming up — session probe retries until known */
    }
  }

  const session = await waitForKnownSession(hasSession, deskId, {
    timeoutMs: sessionProbeTimeoutMs,
    intervalMs: sessionProbeIntervalMs,
    sleep,
    now,
  });
  if (session === false) {
    await revert();
    return { ok: false, status: 403, error: CHATGPT_NOT_LOGGED_IN, cdp: false };
  }
  if (session == null) {
    await revert();
    return { ok: false, status: 502, error: SESSION_UNKNOWN, cdp: false };
  }

  const members = assignedMembers(users, deskId);
  const failures = [];
  for (const member of members) {
    if (users.projectUrlOn?.(member.id, deskId)) continue;
    let result;
    try {
      result = await createProject(deskId, member);
    } catch (e) {
      result = { ok: false, error: e.message || UI_CHANGED };
    }
    const accepted = result?.skipped ? { ok: true, url: result.url } : acceptOnboardResult(result);
    if (accepted.ok && accepted.url && !result?.skipped) {
      users.update?.(member.id, {
        projectReady: true,
        projectName: member.username,
        projectDesk: deskId,
        projectUrl: accepted.url,
      });
    } else if (!accepted.ok && !result?.skipped) {
      failures.push({ username: member.username, error: accepted.error });
    } else if (result && result.ok === false) {
      failures.push({ username: member.username, error: formalizeOnboardError(result.error) });
    }
  }

  if (failures.length) {
    await revert();
    return { ok: false, status: 400, error: formatMemberFailures(failures), cdp: false, failures };
  }

  persistCdp?.(true);
  users.setDeskCdp?.(deskId, true);
  return { ok: true, cdp: true };
}

/**
 * Assign desks. CDP-on adds create a project first; failure leaves that desk unassigned.
 */
export async function assignDesksWithProjects({
  user,
  nextDesks,
  users,
  hasSession,
  createProject,
} = {}) {
  const prev = user?.desks || [];
  const known = users.listDeskIds?.();
  const wanted = known ? (nextDesks || []).filter((id) => known.includes(id)) : [...(nextDesks || [])];
  const added = addedDesks(prev, wanted);
  const kept = prev.filter((id) => wanted.includes(id));
  const finalDesks = [...kept];
  const failures = [];

  for (const deskId of added) {
    if (!users.deskCdpOn?.(deskId)) {
      finalDesks.push(deskId);
      continue;
    }
    let session = true;
    if (typeof hasSession === "function") {
      try {
        session = await hasSession(deskId);
      } catch {
        session = null;
      }
    }
    if (session === false) {
      failures.push({ deskId, username: user.username, error: CHATGPT_NOT_LOGGED_IN });
      continue;
    }
    if (session == null) {
      failures.push({ deskId, username: user.username, error: SESSION_UNKNOWN });
      continue;
    }
    if (users.projectUrlOn?.(user.id, deskId)) {
      finalDesks.push(deskId);
      continue;
    }
    let result;
    try {
      result = await createProject(deskId, user);
    } catch (e) {
      result = { ok: false, error: e.message || UI_CHANGED };
    }
    const accepted = result?.skipped ? { ok: true, url: result.url } : acceptOnboardResult(result);
    if (accepted.ok && accepted.url) {
      if (!result?.skipped) {
        users.update?.(user.id, {
          projectReady: true,
          projectName: user.username,
          projectDesk: deskId,
          projectUrl: accepted.url,
        });
      }
      finalDesks.push(deskId);
    } else {
      failures.push({
        deskId,
        username: user.username,
        error: accepted.error || formalizeOnboardError(result?.error),
      });
    }
  }

  users.update?.(user.id, { desks: finalDesks });
  const fresh = users.get?.(user.id) || { ...user, desks: finalDesks };
  if (failures.length) {
    return { ok: false, status: 400, error: formatMemberFailures(failures), user: fresh, failures };
  }
  return { ok: true, user: fresh };
}

/**
 * Rename creates a new same-username project on every CDP-on desk.
 * Username is persisted only after every required create succeeds.
 */
export async function renameMemberWithProjects({
  user,
  username,
  users,
  hasSession,
  createProject,
} = {}) {
  const name = String(username || "").trim();
  if (!name || name.length > 32) return { ok: false, status: 400, error: "用户名 1–32 个字符" };
  if (name === user.username) return { ok: true, user, skipped: true };

  const cdpDesks = desksNeedingProject(user, users);
  const newUrls = {};
  const failures = [];
  for (const deskId of cdpDesks) {
    let session = true;
    if (typeof hasSession === "function") {
      try {
        session = await hasSession(deskId);
      } catch {
        session = null;
      }
    }
    if (session === false) {
      failures.push({ deskId, username: name, error: CHATGPT_NOT_LOGGED_IN });
      continue;
    }
    if (session == null) {
      failures.push({ deskId, username: name, error: SESSION_UNKNOWN });
      continue;
    }
    let result;
    try {
      result = await createProject(deskId, { ...user, username: name }, { skipIfUrl: false, name });
    } catch (e) {
      result = { ok: false, error: e.message || UI_CHANGED };
    }
    const accepted = acceptOnboardResult(result);
    if (accepted.ok && accepted.url) newUrls[deskId] = accepted.url;
    else failures.push({ deskId, username: name, error: accepted.error || formalizeOnboardError(result?.error) });
  }

  if (failures.length) {
    return { ok: false, status: 400, error: formatMemberFailures(failures), user };
  }

  const patch = { username: name, projectName: name };
  users.update?.(user.id, patch);
  for (const [deskId, url] of Object.entries(newUrls)) {
    users.update?.(user.id, { projectDesk: deskId, projectUrl: url, projectName: name });
  }
  return { ok: true, user: users.get?.(user.id) || { ...user, username: name, projectUrls: newUrls } };
}
