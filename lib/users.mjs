import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { hashPassword, passwordMatches, needsRehash } from "./auth.mjs";

function projectDesksOf(u) {
  return u?.projectDesks && typeof u.projectDesks === "object" ? { ...u.projectDesks } : {};
}

function publicSettings(raw) {
  return { assist: !!(raw && raw.assist) };
}

export function publicUser(u) {
  const projectDesks = projectDesksOf(u);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    desks: [...(u.desks || [])],
    disabled: !!u.disabled,
    projectReady: !!u.projectReady || Object.values(projectDesks).some(Boolean),
    projectDesks,
    projectName: u.projectName || u.username || "",
  };
}

export function createUserStore({ file, adminUser, adminPassword, deskIds }) {
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
  data.settings = publicSettings(data.settings);
  if (!data.deskNames || typeof data.deskNames !== "object") data.deskNames = {};
  if (!data.deskProxies || typeof data.deskProxies !== "object") data.deskProxies = {};

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
        projectName: "",
      };
      data.users.push(u);
      persist();
      return publicUser(u);
    },
    update(id, patch) {
      const u = findById(id);
      if (!u) throw new Error("用户不存在");
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
        u.projectDesks = { ...projectDesksOf(u), [String(patch.projectDesk)]: true };
        u.projectReady = true;
      }
      persist();
      return publicUser(u);
    },
    readyOn(id, deskId) {
      const u = findById(id);
      if (!u) return false;
      return !!projectDesksOf(u)[deskId];
    },
    remove(id) {
      const u = findById(id);
      if (!u) throw new Error("用户不存在");
      if (u.role === "admin") throw new Error("不能删除管理员");
      data.users = data.users.filter((x) => x.id !== id);
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
    setDeskProxy(id, url) {
      if (!deskIds.includes(id)) throw new Error("账号不存在");
      const u = String(url || "").trim();
      if (u.length > 200) throw new Error("代理地址太长");
      if (u && !/^(https?|socks5?):\/\/\S+$/i.test(u)) throw new Error("代理格式应为 http:// https:// 或 socks5://");
      if (u) data.deskProxies[id] = u;
      else delete data.deskProxies[id];
      persist();
      return u;
    },
    canOpen(user, deskId) {
      if (!user) return false;
      if (user.role === "admin") return deskIds.includes(deskId);
      return (user.desks || []).includes(deskId);
    },
    settings() {
      return publicSettings(data.settings);
    },
    setSettings(patch) {
      const next = publicSettings(data.settings);
      if (typeof patch.assist === "boolean") next.assist = patch.assist;
      data.settings = next;
      persist();
      return publicSettings(data.settings);
    },
    assistOn() {
      return !!data.settings?.assist;
    },
  };
}
