import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { hashPassword, passwordMatches, needsRehash } from "./auth.mjs";
import { canonicalizeProjectUrl } from "./project-jail.mjs";

function projectDesksOf(u) {
  return u?.projectDesks && typeof u.projectDesks === "object" ? { ...u.projectDesks } : {};
}

function projectUrlsOf(u) {
  if (!u?.projectUrls || typeof u.projectUrls !== "object") return {};
  const out = {};
  for (const [id, url] of Object.entries(u.projectUrls)) {
    const home = canonicalizeProjectUrl(url);
    if (home) out[id] = home;
  }
  return out;
}

function publicSettings() {
  return {};
}

function deskCdpMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, on] of Object.entries(raw)) {
    if (on) out[id] = true;
  }
  return out;
}

export function publicUser(u) {
  const projectDesks = projectDesksOf(u);
  const projectUrls = projectUrlsOf(u);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    desks: [...(u.desks || [])],
    disabled: !!u.disabled,
    projectReady: !!u.projectReady || Object.values(projectDesks).some(Boolean),
    projectDesks,
    projectUrls,
    projectName: u.projectName || u.username || "",
  };
}

export function createUserStore({ file, adminUser, adminPassword, deskIds: seedDeskIds }) {
  if (!file) throw new Error("users file required");
  mkdirSync(dirname(file), { recursive: true });
  let data = { users: [] };
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      data = { users: [] };
    }
  }
  if (!Array.isArray(data.users)) data.users = [];
  data.settings = publicSettings();
  data.deskCdp = deskCdpMap(data.deskCdp);
  if (!data.deskNames || typeof data.deskNames !== "object") data.deskNames = {};
  if (!data.deskProxies || typeof data.deskProxies !== "object") data.deskProxies = {};
  if (!Array.isArray(data.extraDeskIds)) data.extraDeskIds = [];
  if (!Array.isArray(data.proxyPresets)) data.proxyPresets = [];

  const seedSet = new Set(seedDeskIds || []);
  const deskIds = [];
  const seen = new Set();
  for (const id of [...(seedDeskIds || []), ...data.extraDeskIds]) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    deskIds.push(id);
  }
  data.extraDeskIds = data.extraDeskIds.filter((id) => typeof id === "string" && seen.has(id) && !seedSet.has(id));

  const PROXY_RE = /^(https?|socks5?):\/\/\S+$/i;
  const PRESET_CAP = 8;

  const normalizeProxy = (url) => {
    const u = String(url || "").trim();
    if (u.length > 200) throw new Error("代理地址太长");
    if (u && !PROXY_RE.test(u)) throw new Error("代理格式应为 http:// https:// 或 socks5://");
    return u;
  };

  const rememberProxy = (u) => {
    if (!u) return;
    data.proxyPresets = [u, ...data.proxyPresets.filter((x) => x !== u)].slice(0, PRESET_CAP);
  };

  data.proxyPresets = data.proxyPresets.filter((u) => typeof u === "string" && PROXY_RE.test(u.trim()));
  for (const u of Object.values(data.deskProxies)) {
    if (typeof u === "string" && PROXY_RE.test(u) && !data.proxyPresets.includes(u)) data.proxyPresets.push(u);
  }
  data.proxyPresets = data.proxyPresets.slice(0, PRESET_CAP);

  const persist = () => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  };

  // 预设了 AUTH_PASSWORD（自动化部署）才在启动时建管理员；否则留给首次访问的网页向导。
  if (adminPassword && !data.users.some((u) => u.role === "admin")) {
    data.users.push({
      id: randomUUID(),
      username: adminUser || "admin",
      role: "admin",
      passwordHash: hashPassword(adminPassword),
      desks: [...deskIds],
      disabled: false,
      projectReady: false,
      projectDesks: {},
      projectUrls: {},
      projectName: "",
    });
    persist();
  }

  const findByUsername = (name) => data.users.find((u) => u.username === name);
  const findById = (id) => data.users.find((u) => u.id === id);

  return {
    hasAdmin() {
      return data.users.some((u) => u.role === "admin");
    },
    createAdmin({ username, password }) {
      if (data.users.some((u) => u.role === "admin")) throw new Error("管理员已存在");
      return this.create({ username, password, role: "admin", desks: [...deskIds] });
    },
    login(username, password) {
      const u = findByUsername(String(username || "").trim());
      if (!u || u.disabled) return null;
      if (!passwordMatches(String(password || ""), u.passwordHash)) return null;
      if (needsRehash(u.passwordHash)) {
        u.passwordHash = hashPassword(String(password));
        persist();
      }
      return publicUser(u);
    },
    get(id) {
      const u = findById(id);
      return u ? publicUser(u) : null;
    },
    list() {
      return data.users.map(publicUser);
    },
    create({ username, password, desks, role }) {
      const name = String(username || "").trim();
      if (!name || name.length > 32) throw new Error("用户名 1–32 个字符");
      if (findByUsername(name)) throw new Error("用户名已存在");
      if (String(password || "").length < 6) throw new Error("密码至少 6 位");
      const r = role === "admin" ? "admin" : "member";
      const allowed = (desks || []).filter((d) => deskIds.includes(d));
      const u = {
        id: randomUUID(),
        username: name,
        role: r,
        passwordHash: hashPassword(password),
        desks: r === "admin" ? [...deskIds] : allowed,
        disabled: false,
        projectReady: false,
        projectDesks: {},
        projectUrls: {},
        projectName: "",
      };
      data.users.push(u);
      persist();
      return publicUser(u);
    },
    update(id, patch) {
      const u = findById(id);
      if (!u) throw new Error("用户不存在");
      if (patch.username != null) {
        const name = String(patch.username).trim();
        if (!name || name.length > 32) throw new Error("用户名 1–32 个字符");
        const other = findByUsername(name);
        if (other && other.id !== u.id) throw new Error("用户名已存在");
        u.username = name;
        if (patch.projectName == null) u.projectName = name;
      }
      if (patch.desks) {
        u.desks = u.role === "admin" ? [...deskIds] : patch.desks.filter((d) => deskIds.includes(d));
      }
      if (patch.password) {
        if (String(patch.password).length < 6) throw new Error("密码至少 6 位");
        u.passwordHash = hashPassword(patch.password);
      }
      if (typeof patch.disabled === "boolean" && u.role !== "admin") u.disabled = patch.disabled;
      if (typeof patch.projectReady === "boolean") u.projectReady = patch.projectReady;
      if (patch.projectName != null) u.projectName = String(patch.projectName).trim();
      if (patch.projectDesk) {
        const deskId = String(patch.projectDesk);
        u.projectDesks = { ...projectDesksOf(u), [deskId]: true };
        u.projectReady = true;
        const home = canonicalizeProjectUrl(patch.projectUrl);
        if (home) u.projectUrls = { ...projectUrlsOf(u), [deskId]: home };
      }
      persist();
      return publicUser(u);
    },
    assignedMembers(deskId) {
      return data.users
        .filter((u) => u.role !== "admin" && (u.desks || []).includes(deskId))
        .map(publicUser);
    },
    readyOn(id, deskId) {
      const u = findById(id);
      if (!u) return false;
      return !!projectDesksOf(u)[deskId];
    },
    projectUrlOn(id, deskId) {
      const u = findById(id);
      if (!u) return "";
      return projectUrlsOf(u)[deskId] || "";
    },
    remove(id) {
      const u = findById(id);
      if (!u) throw new Error("用户不存在");
      if (u.role === "admin") throw new Error("不能删除管理员");
      data.users = data.users.filter((x) => x.id !== id);
      persist();
    },
    listDeskIds() {
      return [...deskIds];
    },
    extraDeskIds() {
      return [...data.extraDeskIds];
    },
    isExtraDesk(id) {
      return data.extraDeskIds.includes(id);
    },
    addDesk(id, name) {
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new Error("账号 id 不合法");
      if (deskIds.includes(id)) throw new Error("账号已存在");
      const n = String(name || "").trim();
      if (n.length > 24) throw new Error("名字最多 24 个字符");
      deskIds.push(id);
      if (!seedSet.has(id) && !data.extraDeskIds.includes(id)) data.extraDeskIds.push(id);
      if (n) data.deskNames[id] = n;
      for (const u of data.users) {
        if (u.role === "admin") u.desks = [...deskIds];
      }
      persist();
      return { id, name: n };
    },
    removeDesk(id) {
      if (!deskIds.includes(id)) throw new Error("账号不存在");
      if (seedSet.has(id) || !data.extraDeskIds.includes(id)) throw new Error("内置账号不能删除");
      deskIds.splice(deskIds.indexOf(id), 1);
      data.extraDeskIds = data.extraDeskIds.filter((x) => x !== id);
      delete data.deskNames[id];
      delete data.deskProxies[id];
      delete data.deskCdp[id];
      for (const u of data.users) {
        u.desks = u.role === "admin" ? [...deskIds] : (u.desks || []).filter((d) => d !== id);
        if (u.projectDesks && typeof u.projectDesks === "object") delete u.projectDesks[id];
        if (u.projectUrls && typeof u.projectUrls === "object") delete u.projectUrls[id];
      }
      persist();
    },
    deskNameOf(id) {
      return data.deskNames[id] || "";
    },
    renameDesk(id, name) {
      if (!deskIds.includes(id)) throw new Error("账号不存在");
      const n = String(name || "").trim();
      if (n.length > 24) throw new Error("名字最多 24 个字符");
      if (n) data.deskNames[id] = n;
      else delete data.deskNames[id];
      persist();
      return n;
    },
    deskProxyOf(id) {
      return data.deskProxies[id] || "";
    },
    proxyPresets() {
      return [...data.proxyPresets];
    },
    setDeskProxy(id, url) {
      if (!deskIds.includes(id)) throw new Error("账号不存在");
      const u = normalizeProxy(url);
      if (u) {
        data.deskProxies[id] = u;
        rememberProxy(u);
      } else {
        delete data.deskProxies[id];
      }
      persist();
      return u;
    },
    setAllDeskProxies(url) {
      const u = normalizeProxy(url);
      for (const id of deskIds) {
        if (u) data.deskProxies[id] = u;
        else delete data.deskProxies[id];
      }
      if (u) rememberProxy(u);
      persist();
      return u;
    },
    canOpen(user, deskId) {
      if (!user) return false;
      if (user.role === "admin") return deskIds.includes(deskId);
      return (user.desks || []).includes(deskId);
    },
    settings() {
      return publicSettings();
    },
    setSettings() {
      data.settings = publicSettings();
      persist();
      return publicSettings();
    },
    deskCdpOn(_id) {
      // Split-screen withdrawn: one ChatGPT login cannot isolate seats. Ignore stored flags.
      return false;
    },
    setDeskCdp(id, on) {
      if (!deskIds.includes(id)) throw new Error("账号不存在");
      if (on) throw new Error("多人分屏暂未开放");
      delete data.deskCdp[id];
      persist();
      return false;
    },
    /** Folded into per-desk CDP. Page assist only runs when that desk's debug port is on. */
    assistOn(id) {
      return this.deskCdpOn(id);
    },
  };
}
