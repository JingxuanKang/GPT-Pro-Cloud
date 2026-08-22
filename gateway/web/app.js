const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "content-type": "application/json", ...opts.headers } : opts.headers,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && state.me && path !== "/api/login" && path !== "/api/setup") {
      state.me = null;
      state.boot = false;
      setHash("/login");
    }
    throw new Error(data.error || "出了点问题，请再试一次");
  }
  return data;
}

const state = { me: null, desks: [], presence: {}, users: [], settings: {}, proxyPresets: [], view: "home", deskId: null, deskMode: "vnc", seatId: null, err: "", modal: false, manage: null, rename: null, create: false, assign: null, resetPw: null, selfPw: false, seatCap: 3, setup: false, boot: true };

function deskCdpOn(_id) {
  return false;
}

function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  if (h.startsWith("/desk/")) {
    state.view = "desk";
    state.deskId = h.slice("/desk/".length);
    return;
  }
  state.view = h === "/admin" ? "admin" : h === "/settings" ? "settings" : h === "/login" ? "login" : "home";
}

function setHash(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else {
    route();
    render();
  }
}

function people(id) {
  return state.presence[id] || [];
}

function occupancy(user) {
  if (!user) return [];
  const ids = [];
  for (const [deskId, vs] of Object.entries(state.presence || {})) {
    if ((vs || []).some((v) => v.id === user.id || v.username === user.username)) ids.push(deskId);
  }
  return ids;
}

function deskName(id) {
  return state.desks.find((d) => d.id === id)?.name || "ChatGPT";
}

function hue(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 33 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}

function av(name, cls = "av") {
  const letter = esc(String(name || "?").slice(0, 1).toUpperCase());
  return `<span class="${cls}" style="--h:${hue(name)}">${letter}</span>`;
}

const MARK = `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.9 1.8c.5 5.9 3.4 8.8 9.3 9.3v1.8c-5.9.5-8.8 3.4-9.3 9.3h-1.8c-.5-5.9-3.4-8.8-9.3-9.3v-1.8c5.9-.5 8.8-3.4 9.3-9.3h1.8z"/></svg>`;

const BLOOM = `<svg class="bloom" viewBox="0 0 41 41" aria-hidden="true"><path d="M37.5 16.7a9.3 9.3 0 0 0-1.3-8.4 9.5 9.5 0 0 0-10.2-3.6 9.5 9.5 0 0 0-7.2-5.7 9.5 9.5 0 0 0-9 4.3A9.4 9.4 0 0 0 3 8.8a9.5 9.5 0 0 0 1.1 10.8 9.4 9.4 0 0 0-1.4 8.5 9.5 9.5 0 0 0 10.2 3.6 9.5 9.5 0 0 0 7.3 5.7 9.5 9.5 0 0 0 9-4.3 9.4 9.4 0 0 0 6.7-5.5 9.5 9.5 0 0 0-1.1-10.9zm-15.3 18a7.1 7.1 0 0 1-4.6-1.7l.1-.1 6.3-3.6a1 1 0 0 0 .5-.9v-8.9l2.7 1.5a.1.1 0 0 1 .1.1v7.3a7.2 7.2 0 0 1-5.1 6.3zm-13.7-5.8a7.1 7.1 0 0 1-.9-4.8l.1.1 6.3 3.6a1 1 0 0 0 1 0l7.7-4.4v3.1a.1.1 0 0 1 0 .1l-6.4 3.7a7.2 7.2 0 0 1-7.8-1.4zm-1.8-14.8a7.1 7.1 0 0 1 3.7-3.1v.1l6.3 3.6a1 1 0 0 0 .5.9v8.9l-2.7-1.5a.1.1 0 0 1-.1-.1v-7.3a7.2 7.2 0 0 1-7.7-1.5zm27.3 3.2-6.3-3.6a1 1 0 0 0-1 0l-7.7 4.4v-3.1a.1.1 0 0 1 0-.1l6.3-3.7a7.2 7.2 0 0 1 8.7 9.3zm3.3 4.8-.1-.1-6.3-3.6a1 1 0 0 0-1 0L20.6 21v-3.1a.1.1 0 0 1 0-.1l6.4-3.6a7.2 7.2 0 0 1 2.3 10.4zM14.6 22.3l-2.7-1.6a.1.1 0 0 1-.1-.1v-7.3a7.2 7.2 0 0 1 11.8-5.5l-.1.1-6.3 3.6a1 1 0 0 0-.5.9v8.9z"/></svg>`;

const ICO = {
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 5l-7 7 7 7"/></svg>`,
  image: `<svg class="ico-img" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm1.2 13h11.6l-3.4-4.6-2.6 3.3-2.2-2.6L6.2 17ZM8 9.2A1.6 1.6 0 1 0 8 6a1.6 1.6 0 0 0 0 3.2Z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 14V4M8.5 7 12 3.5 15.5 7M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>`,
  arrow: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.2 5.3 18.9 11l.9 1-.9 1-5.7 5.7-1.4-1.4 4.3-4.3H4v-2h12.1l-4.3-4.3 1.4-1.4Z"/></svg>`,
  pencil: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>`,
  plus: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>`,
  users: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11Zm-5.5 8.5c.6-3.2 2.9-4.9 5.5-4.9s4.9 1.7 5.5 4.9M15.5 10.7a2.8 2.8 0 1 0-1.6-5.3M16 14.8c2 .4 3.6 1.8 4.1 4.2"/></svg>`,
  user: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M12 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5 20c.8-3.8 3.8-5.7 7-5.7s6.2 1.9 7 5.7"/></svg>`,
  lock: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>`,
  key: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M11.5 12H20M17 12v3M20 12v2.5"/></svg>`,
  ban: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path stroke="currentColor" stroke-width="1.8" d="M6.5 6.5l11 11"/></svg>`,
  trash: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 7V4h4v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>`,
  grid: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>`,
  userplus: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20c.7-3.6 3.4-5.5 6.5-5.5 1.1 0 2.1.2 3 .7M18 14v6M15 17h6"/></svg>`,
  userx: `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20c.7-3.6 3.4-5.5 6.5-5.5 1.1 0 2.1.2 3 .7M16 15l5 5M21 15l-5 5"/></svg>`,
  clip: `<svg class="ico-clip" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" d="M9 4h6v3H9zM15 5h3a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 16V5M8 8.5 12 4.5 16 8.5M6 19h12"/></svg>`,
};

function greet() {
  const h = new Date().getHours();
  if (h < 5) return "夜深了";
  if (h < 12) return "早上好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function renderBoot() {
  return `<div class="boot">${MARK}</div>`;
}

function renderLogin() {
  return `<div class="auth">
    <div class="auth-brand">${MARK}<span>GPT&#8209;Pro Cloud</span></div>
    <form class="auth-card" id="login-form">
      <h1>欢迎回来</h1>
      <p class="hint">登录以使用团队的 ChatGPT 账号</p>
      <div class="err" id="err">${esc(state.err)}</div>
      <label class="field"><span>用户名</span><span class="inwrap">${ICO.user}<input name="username" autocomplete="username" autofocus required></span></label>
      <label class="field"><span>密码</span><span class="inwrap">${ICO.lock}<input name="password" type="password" autocomplete="current-password" required></span></label>
      <button class="btn lg block" type="submit">登录</button>
    </form>
    <p class="auth-foot">账号由管理员分配</p>
  </div>`;
}

function renderSetup() {
  return `<div class="auth">
    <div class="auth-brand">${MARK}<span>GPT&#8209;Pro Cloud</span></div>
    <form class="auth-card" id="setup-form">
      <h1>创建管理员</h1>
      <p class="hint">首次部署：设置管理员账号，之后用它登录并邀请成员</p>
      <div class="err" id="err"></div>
      <label class="field"><span>用户名</span><span class="inwrap">${ICO.user}<input name="username" autocomplete="off" maxlength="32" autofocus required></span></label>
      <label class="field"><span>密码</span><span class="inwrap">${ICO.lock}<input name="password" type="password" autocomplete="new-password" minlength="6" required></span></label>
      <label class="field"><span>确认密码</span><span class="inwrap">${ICO.lock}<input name="password2" type="password" autocomplete="new-password" minlength="6" required></span></label>
      <button class="btn lg block" type="submit">创建并登录</button>
    </form>
    <p class="auth-foot">这个向导只在还没有管理员时出现</p>
  </div>`;
}

function shell(inner) {
  const admin =
    state.me?.role === "admin"
      ? `<a href="#/admin" class="top-link ${state.view === "admin" ? "on" : ""}">管理</a>
         <a href="#/settings" class="top-link ${state.view === "settings" ? "on" : ""}">设置</a>`
      : "";
  return `<div class="app">
    <header class="top">
      <a href="#/" class="brand">${MARK}<span>GPT&#8209;Pro Cloud</span></a>
      <a href="#/" class="top-link ${state.view === "home" ? "on" : ""}">工作台</a>
      ${admin}
      <span class="top-sep"></span>
      <span class="top-user">${av(state.me?.username)}<span>${esc(state.me?.username)}</span></span>
      <button type="button" class="text-btn" id="logout">退出</button>
    </header>
    <main class="page">${inner}</main>
  </div>`;
}

function seatCap() {
  return state.seatCap || 3;
}

function deskStatus(live) {
  return live
    ? `<span class="status live"><i></i>使用中</span>`
    : `<span class="status"><i></i>空闲</span>`;
}

function deskOcc(d) {
  const vs = people(d.id);
  const cap = deskCdpOn(d.id) ? seatCap() : 1;
  if (!vs.length) return `<div class="occ empty"><span class="seats">${ICO.users}0/${cap}</span></div>`;
  const stack = vs
    .slice(0, 4)
    .map((v) => av(v.username, "av mini"))
    .join("");
  return `<div class="occ"><span class="stack">${stack}</span><span class="seats">${ICO.users}${vs.length}/${cap}</span></div>`;
}

function renderHome() {
  const name = esc(state.me?.username || "");
  const isAdmin = state.me?.role === "admin";
  const head = `<header class="page-head">
    <h1 class="display">${greet()}，${name}</h1>
    ${state.desks.length ? "" : `<p class="hint">还没有可使用的账号，请联系管理员开通。</p>`}
  </header>`;
  const cards = state.desks
    .map((d) => {
      const live = people(d.id).length > 0;
      return `<div class="card click" data-open="${esc(d.id)}" role="button" tabindex="0">
        <div class="card-head"><span class="tile">${BLOOM}</span>${deskStatus(live)}</div>
        <span class="card-name"><span>${esc(d.name)}</span></span>
        ${deskOcc(d)}
        <span class="btn ${live ? "" : "ghost"} block">进入${ICO.arrow}</span>
      </div>`;
    })
    .join("");
  const addCard = isAdmin
    ? `<div class="card add" data-add-desk role="button" tabindex="0">
        <span class="add-ring">${ICO.plus}</span>
        <b>添加账号</b>
      </div>`
    : "";
  const grid = cards || addCard ? `<div class="cardgrid home">${cards}${addCard}</div>` : "";
  return shell(`${head}${grid}${renderCreateModal()}`);
}

function renderCreateModal() {
  return state.create
    ? `<div class="mask" id="create-mask">
        <form class="sheet" id="create-form">
          <h2>添加 ChatGPT 账号</h2>
          <p class="hint">会启动一台新的 Chromium 桌面。打开新卡片后登录一次 ChatGPT，之后就能像现有账号一样分给成员。</p>
          <div class="err" id="create-err"></div>
          <label class="field"><span>名字</span><input name="name" maxlength="24" placeholder="例如 客户号" autofocus autocomplete="off" required></label>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="create-cancel">取消</button>
            <button class="btn" type="submit">添加</button>
          </div>
        </form>
      </div>`
    : "";
}

function memberStatus(u) {
  if (u.disabled) return `<span class="status off"><i></i>已停用</span>`;
  return occupancy(u).length
    ? `<span class="status live"><i></i>在线</span>`
    : `<span class="status"><i></i>离线</span>`;
}

function renderAdmin() {
  if (state.me?.role !== "admin") return renderHome();
  const deskCards = state.desks
    .map((d) => {
      const vs = people(d.id);
      const live = vs.length > 0;
      const others = vs.filter((v) => v.id && v.id !== state.me?.id);
      return `<article class="card">
        <div class="card-head row"><span class="tile sm">${BLOOM}</span><span class="card-name"><span>${esc(d.name)}</span></span>${deskStatus(live)}</div>
        ${deskOcc(d)}
        <button type="button" class="btn ${live ? "" : "ghost"} block" data-open="${esc(d.id)}">进入${ICO.arrow}</button>
        <div class="acts">
          <button type="button" class="act" data-rename="${esc(d.id)}">${ICO.pencil}重命名</button>
          <button type="button" class="act" data-assign="${esc(d.id)}">${ICO.userplus}分配</button>
          ${others.length ? `<button type="button" class="act" data-kick-desk="${esc(d.id)}" data-kick-name="${esc(d.name)}">${ICO.userx}断开</button>` : ""}
          ${d.extra ? `<button type="button" class="act danger" data-delete="${esc(d.id)}" data-delete-name="${esc(d.name)}" data-delete-live="${live ? "1" : ""}">${ICO.trash}删除</button>` : ""}
        </div>
      </article>`;
    })
    .join("");
  const members = state.users.filter((u) => u.role !== "admin");
  const memberCards = members
    .map((u) => {
      const chips = (u.desks || [])
        .map((id) => `<span class="chip">${BLOOM}${esc(deskName(id))}</span>`)
        .join("");
      return `<article class="card">
        <div class="card-head row">${av(u.username, "av big")}<span class="card-name"><span>${esc(u.username)}</span></span>${memberStatus(u)}</div>
        <div class="chips">${chips || `<span class="chip none">未分配账号</span>`}</div>
        <div class="acts">
          <button type="button" class="act" data-manage="${esc(u.id)}">${ICO.grid}可用账号</button>
          <button type="button" class="act" data-resetpw="${esc(u.id)}">${ICO.key}重置密码</button>
          <button type="button" class="act" data-toggle="${esc(u.id)}" data-disabled="${u.disabled ? "1" : ""}" data-name="${esc(u.username)}">${ICO.ban}${u.disabled ? "启用" : "停用"}</button>
          <button type="button" class="act danger" data-del="${esc(u.id)}" data-name="${esc(u.username)}">${ICO.trash}移除</button>
        </div>
      </article>`;
    })
    .join("");
  const myCard = `<article class="card">
    <div class="card-head row">${av(state.me?.username, "av big")}<span class="card-name"><span>${esc(state.me?.username)}</span></span><span class="status ink"><i></i>管理员</span></div>
    <button type="button" class="btn ghost block" id="self-pw">${ICO.key}修改密码</button>
  </article>`;
  return shell(`<header class="page-head"><h1 class="display">管理</h1></header>
    <div class="sec-head">${BLOOM}<b>ChatGPT 账号</b><button type="button" class="sec-add" data-add-desk>${ICO.plus}添加账号</button></div>
    <div class="cardgrid">${deskCards}</div>
    <div class="sec-head">${ICO.users}<b>成员</b><button type="button" class="sec-add" id="add-user">${ICO.plus}邀请成员</button></div>
    <div class="cardgrid">${memberCards || `<article class="card add" data-invite-empty role="button" tabindex="0"><span class="add-ring">${ICO.plus}</span><b>邀请成员</b></article>`}</div>
    <div class="sec-head">${ICO.user}<b>我的账号</b></div>
    <div class="cardgrid">${myCard}</div>
    ${renderCreateModal()}${renderAdminModals()}`);
}

function renderAdminModals() {
  const checks = state.desks
    .map((d) => `<label class="pick"><input type="checkbox" name="desks" value="${esc(d.id)}" checked> ${esc(d.name)}</label>`)
    .join("");
  const invite = state.modal
    ? `<div class="mask" id="modal">
        <form class="sheet" id="user-form">
          <h2>邀请成员</h2>
          <p class="hint">对方将用这个账号登录，并使用你勾选的 ChatGPT。</p>
          <div class="err" id="err"></div>
          <label class="field"><span>用户名</span><input name="username" autocomplete="off" required></label>
          <label class="field"><span>密码</span><input name="password" type="password" autocomplete="new-password" required minlength="6"></label>
          <div class="field">
            <span>可使用</span>
            <div class="picks">${checks}</div>
          </div>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="cancel">取消</button>
            <button class="btn" type="submit">邀请</button>
          </div>
        </form>
      </div>`
    : "";
  const mu = state.manage ? state.users.find((u) => u.id === state.manage) : null;
  const manageChecks = mu
    ? state.desks
        .map(
          (d) =>
            `<label class="pick"><input type="checkbox" name="desks" value="${esc(d.id)}" ${(mu.desks || []).includes(d.id) ? "checked" : ""}> ${esc(d.name)}</label>`,
        )
        .join("")
    : "";
  const manageModal = mu
    ? `<div class="mask" id="manage-mask">
        <form class="sheet" id="manage-form">
          <h2>可用账号</h2>
          <p class="hint">勾选 ${esc(mu.username)} 可以使用的 ChatGPT 账号。</p>
          <div class="err" id="manage-err"></div>
          <div class="picks">${manageChecks}</div>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="manage-cancel">取消</button>
            <button class="btn" type="submit">保存</button>
          </div>
        </form>
      </div>`
    : "";
  const ad = state.assign ? state.desks.find((d) => d.id === state.assign) : null;
  const assignChecks = ad
    ? state.users
        .filter((u) => u.role !== "admin")
        .map(
          (u) =>
            `<label class="pick"><input type="checkbox" name="users" value="${esc(u.id)}" ${(u.desks || []).includes(ad.id) ? "checked" : ""}> ${esc(u.username)}</label>`,
        )
        .join("")
    : "";
  const assignModal = ad
    ? `<div class="mask" id="assign-mask">
        <form class="sheet" id="assign-form">
          <h2>分配成员</h2>
          <p class="hint">勾选可以使用「${esc(ad.name)}」的成员。</p>
          <div class="err" id="assign-err"></div>
          <div class="picks">${assignChecks || `<span class="hint">还没有成员，先邀请一位。</span>`}</div>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="assign-cancel">取消</button>
            <button class="btn" type="submit">保存</button>
          </div>
        </form>
      </div>`
    : "";
  const ru = state.resetPw ? state.users.find((u) => u.id === state.resetPw) : null;
  const resetModal = ru
    ? `<div class="mask" id="resetpw-mask">
        <form class="sheet" id="resetpw-form">
          <h2>重置密码</h2>
          <p class="hint">给 ${esc(ru.username)} 设一个新密码，对方已有会话会立即失效。</p>
          <div class="err" id="resetpw-err"></div>
          <label class="field"><span>新密码</span><span class="inwrap">${ICO.lock}<input name="password" type="password" autocomplete="new-password" minlength="6" autofocus required></span></label>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="resetpw-cancel">取消</button>
            <button class="btn" type="submit">保存</button>
          </div>
        </form>
      </div>`
    : "";
  const selfModal = state.selfPw
    ? `<div class="mask" id="selfpw-mask">
        <form class="sheet" id="selfpw-form">
          <h2>修改密码</h2>
          <p class="hint">保存后需要用新密码重新登录。</p>
          <div class="err" id="selfpw-err"></div>
          <label class="field"><span>新密码</span><span class="inwrap">${ICO.lock}<input name="password" type="password" autocomplete="new-password" minlength="6" autofocus required></span></label>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="selfpw-cancel">取消</button>
            <button class="btn" type="submit">保存</button>
          </div>
        </form>
      </div>`
    : "";
  const rd = state.rename ? state.desks.find((d) => d.id === state.rename) : null;
  const renameModal = rd
    ? `<div class="mask" id="rename-mask">
        <form class="sheet" id="rename-form">
          <h2>重命名账号</h2>
          <p class="hint">这个名字对所有成员可见。留空则恢复默认名。</p>
          <div class="err" id="rename-err"></div>
          <label class="field"><span>名字</span><input name="name" value="${esc(rd.name)}" maxlength="24" autofocus autocomplete="off"></label>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="rename-cancel">取消</button>
            <button class="btn" type="submit">保存</button>
          </div>
        </form>
      </div>`
    : "";
  return `${invite}${manageModal}${assignModal}${resetModal}${selfModal}${renameModal}`;
}

function sharedProxyValue() {
  const vals = state.desks.map((d) => d.proxy || "");
  if (vals.length && vals.every((v) => v === vals[0])) return vals[0];
  return state.proxyPresets[0] || "";
}

function renderSettings() {
  if (state.me?.role !== "admin") return renderHome();
  const presets = (state.proxyPresets || [])
    .map((u) => `<button type="button" class="chip" data-proxy-pick="${esc(u)}" title="${esc(u)}">${esc(u)}</button>`)
    .join("");
  const rows = state.desks
    .map(
      (d) => `<div class="proxy-row">
        <div class="proxy-id"><b>${esc(d.name)}</b></div>
        <input class="proxy-input" data-proxy-input="${esc(d.id)}" value="${esc(d.proxy || "")}" placeholder="默认出口" autocomplete="off" spellcheck="false">
        <button type="button" class="btn ghost" data-proxy-save="${esc(d.id)}">保存</button>
      </div>`,
    )
    .join("");
  return shell(`<div class="narrow">
    <header class="page-head">
      <h1 class="display">设置</h1>
      <p class="hint">对整个部署生效，仅管理员可见。</p>
    </header>
    <section class="panel">
      <div class="panel-head">
        <b>多人分屏</b>
        <em>多人分屏暂未开放</em>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <b>复制粘贴</b>
        <em>在桌面画面里直接 ⌘C / ⌘V，双向生效。独占 VNC 走整桌剪贴板（文字和截图）。</em>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <b>出口代理</b>
        <em>服务器能直连 ChatGPT 就留空。不能直连时填一个 http:// 或 socks5:// 地址（<code>127.0.0.1</code> 会自动改写为容器可达）。保存即重启该账号的浏览器；「全部应用」下发到所有账号，留空应用恢复默认出口。</em>
      </div>
      ${presets ? `<div class="proxy-presets">${presets}</div>` : ""}
      <div class="proxy-row all">
        <div class="proxy-id"><b>全部账号</b></div>
        <input class="proxy-input" id="proxy-all-input" value="${esc(sharedProxyValue())}" placeholder="应用到全部账号" autocomplete="off" spellcheck="false">
        <button type="button" class="btn ghost" id="proxy-all">全部应用</button>
      </div>
      <div class="proxies">${rows}</div>
    </section>
  </div>`);
}

const isMac = /Mac|iPhone|iPad/.test(String(navigator.userAgent || navigator.platform || ""));
const MOD = isMac ? "Cmd" : "Ctrl";
let lastClip = null;
let lastThumb = "";

function clipKeys() {
  return `<span class="clip-sep"></span><span class="clip-keys"><kbd>${MOD}+C</kbd><kbd>${MOD}+V</kbd></span>`;
}

function toast(msg, kind) {
  let el = $("#gpc-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "gpc-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.innerHTML = `${kind === "image" ? ICO.image : ""}<span>${esc(msg)}</span>`;
  el.classList.add("on");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("on"), 2600);
}

function setChip(kind, text) {
  const chip = $("#clip-chip");
  if (!chip) return;
  chip.classList.add("show");
  chip.classList.toggle("idle", kind === "waiting" || !kind);
  chip.classList.toggle("busy", kind === "pasting" || kind === "copying");
  if (kind === "image") {
    chip.innerHTML = `${ICO.image}<span>image</span>${clipKeys()}`;
    chip.title = "拷到本机";
    return;
  }
  if (kind === "pasting") {
    chip.innerHTML = `<i class="pulse"></i><span>pasting</span>${clipKeys()}`;
    return;
  }
  if (kind === "copying") {
    chip.innerHTML = `<i class="pulse"></i><span>copying</span>${clipKeys()}`;
    return;
  }
  if (text) {
    const one = String(text).replace(/\s+/g, " ").trim();
    chip.innerHTML = `${ICO.clip}<span>${esc(one)}</span>${clipKeys()}`;
    chip.title = "拷到本机";
    return;
  }
  chip.innerHTML = `${ICO.clip}${clipKeys()}`;
  chip.title = `${MOD}+V 贴进来`;
}

async function writeToLocal(text, imageBlob) {
  try {
    if (imageBlob && navigator.clipboard?.write && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ [imageBlob.type || "image/png"]: imageBlob })]);
      return true;
    }
    if (text && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* http / permission */
  }
  if (!text) return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyLastToLocal() {
  if (!lastClip) return false;
  if (lastClip.kind === "image") {
    const blob = new Blob([lastClip.body], { type: lastClip.mime || "image/png" });
    return writeToLocal("", blob);
  }
  return writeToLocal(lastClip.text || "", null);
}

function renderDesk() {
  const d = state.desks.find((x) => x.id === state.deskId);
  const vs = people(state.deskId);
  const names = vs.length ? vs.map((v) => v.username).join("、") : "";
  const tab = state.deskMode === "tab";
  const src = `/vnc/index.html?autoconnect=1&path=websockify&resize=remote&reconnect=true&reconnect_delay=2000&clipboard_up=true&clipboard_down=true&clipboard_seamless=true`;
  const surface = !state.seatId
    ? ""
    : tab
      ? `<canvas id="seat-cast" class="seat-cast" tabindex="0" aria-label="ChatGPT"></canvas>`
      : `<iframe src="${src}" allow="clipboard-read; clipboard-write; autoplay; microphone"></iframe>`;
  return `<div class="stage">
    <div class="chrome">
      <a class="back" href="#/">${ICO.back}<span>工作台</span></a>
      <div class="chrome-mid">
        ${BLOOM}
        <span class="title">${esc(d ? d.name : "ChatGPT")}</span>
        <span class="who" ${names ? "" : "hidden"}>${esc(names)}</span>
      </div>
      <div class="chrome-end">
        ${deskCdpOn(state.deskId) ? `<button type="button" class="chrome-btn" id="share-chat">${ICO.share}<span>分享</span></button>` : ""}
        <button type="button" class="chrome-btn" id="upload-files">${ICO.upload}<span>上传</span></button>
        <button type="button" class="clip-chip" id="clip-chip"></button>
      </div>
    </div>
    <div class="frame">
      <div class="file-drop-shield" id="file-drop-shield" aria-hidden="true"></div>
      <input type="file" id="os-files" multiple hidden accept=".pdf,.doc,.docx,.txt,image/*" />
      <div class="frame-wait" id="frame-wait">${MARK}</div>
      ${surface}
    </div>
  </div>`;
}

function render() {
  const root = $("#app");
  if (state.boot && !state.me) {
    root.innerHTML = renderBoot();
    return;
  }
  if (state.setup && !state.me) {
    root.innerHTML = renderSetup();
    $("#setup-form").onsubmit = onSetup;
    return;
  }
  if (state.view === "login" || !state.me) {
    root.innerHTML = renderLogin();
    $("#login-form").onsubmit = onLogin;
    return;
  }
  if (state.view === "desk") {
    if (state.deskId && !state.seatId && state.me && !state._opening) {
      state._opening = true;
      openDesk(state.deskId)
        .catch((err) => {
          toast(err.message || "无法进入");
          setHash("/");
        })
        .finally(() => {
          state._opening = false;
        });
    }
    root.innerHTML = renderDesk();
    bindDesk();
    return;
  }
  root.innerHTML = state.view === "admin" ? renderAdmin() : state.view === "settings" ? renderSettings() : renderHome();
  bind();
}

async function onLogout(e) {
  e?.preventDefault();
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    /* still leave */
  }
  state.me = null;
  state.modal = false;
  state.manage = null;
  state.rename = null;
  state.create = false;
  state.assign = null;
  state.resetPw = null;
  state.selfPw = false;
  setHash("/login");
}

let peekTimer = 0;
let lastPeeked = "";

function stopPeek() {
  if (peekTimer) {
    clearInterval(peekTimer);
    peekTimer = 0;
  }
}

function dropPresence() {
  stopPeek();
  stopSeatCast();
  stopChooserPoll();
  if (!state.me) return;
  const uid = state.me.username;
  for (const id of Object.keys(state.presence)) {
    state.presence[id] = (state.presence[id] || []).filter((v) => v.username !== uid);
  }
  api("/api/presence/leave", { method: "POST", body: {} }).catch(() => {});
  state.deskMode = "vnc";
  state.seatId = null;
}

function isShareLink(text) {
  return /^https:\/\/chatgpt\.com\/share\/[A-Za-z0-9-]+/i.test(String(text || "").trim());
}

async function adoptDeskText(text, quiet) {
  const t = String(text || "").trim();
  if (!t) return false;
  const url = isShareLink(t) ? t.split(/\s+/)[0] : t;
  if (lastPeeked === url || lastClip?.text === url) return false;
  lastPeeked = url;
  lastClip = { kind: "text", body: url, mime: "text/plain; charset=utf-8", text: url, thumb: "" };
  setChip("text", url);
  const ok = await writeToLocal(url, null);
  if (!quiet) {
    toast(isShareLink(url) ? ok ? "分享链接已复制" : "链接已记下，点格子拷到本机" : ok ? "已拷到本机" : "已记下，点格子拷到本机");
  }
  return true;
}

let seatWs = null;
let seatResize = null;

function stopSeatCast() {
  if (seatWs) {
    try {
      seatWs.close();
    } catch {
      /* ignore */
    }
    seatWs = null;
  }
  if (seatResize && typeof ResizeObserver !== "undefined") {
    try {
      seatResize.disconnect();
    } catch {
      /* ignore */
    }
    seatResize = null;
  }
}

function bindSeatCast() {
  const canvas = $("#seat-cast");
  const wait = $("#frame-wait");
  if (!canvas || !state.seatId) return;
  stopSeatCast();
  canvas.focus();
  const ctx = canvas.getContext("2d");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/seats/${state.seatId}`);
  seatWs = ws;
  const hide = () => wait?.classList.add("gone");
  let view = { width: canvas.clientWidth || 1280, height: canvas.clientHeight || 800 };

  const send = (obj) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  };
  const sendSize = () => {
    const r = canvas.parentElement?.getBoundingClientRect() || canvas.getBoundingClientRect();
    view = { width: Math.max(320, Math.round(r.width)), height: Math.max(320, Math.round(r.height)) };
    send({ type: "size", width: view.width, height: view.height });
  };
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / (r.width || 1)) * view.width,
      y: ((e.clientY - r.top) / (r.height || 1)) * view.height,
    };
  };
  const mods = (e) => (e.altKey ? 1 : 0) + (e.ctrlKey ? 2 : 0) + (e.metaKey ? 4 : 0) + (e.shiftKey ? 8 : 0);

  ws.onopen = () => {
    sendSize();
    setTimeout(hide, 400);
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "error") {
      toast(msg.error || "分屏中断");
      return;
    }
    if (msg.type !== "frame" || !msg.data) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      hide();
    };
    img.src = `data:image/jpeg;base64,${msg.data}`;
  };
  ws.onclose = () => {
    if (state.view === "desk" && state.deskMode === "tab" && seatWs === ws) {
      toast("分屏已断开");
    }
  };

  canvas.onpointerdown = (e) => {
    canvas.focus();
    canvas.setPointerCapture?.(e.pointerId);
    const p = point(e);
    send({ type: "mouse", event: "mousePressed", x: p.x, y: p.y, button: e.button === 2 ? "right" : "left", clickCount: 1, modifiers: mods(e) });
  };
  canvas.onpointerup = (e) => {
    const p = point(e);
    send({ type: "mouse", event: "mouseReleased", x: p.x, y: p.y, button: e.button === 2 ? "right" : "left", clickCount: 1, modifiers: mods(e) });
  };
  canvas.onpointermove = (e) => {
    const p = point(e);
    send({ type: "mouse", event: "mouseMoved", x: p.x, y: p.y, button: "none", modifiers: mods(e) });
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    const p = point(e);
    send({ type: "mouse", event: "mouseWheel", x: p.x, y: p.y, button: "none", deltaX: e.deltaX, deltaY: e.deltaY, modifiers: mods(e) });
  };
  canvas.oncontextmenu = (e) => e.preventDefault();
  const isSeatEscapeChord = (e) => {
    const cmd = e.ctrlKey || e.metaKey;
    const code = e.code || "";
    const key = e.key || "";
    const letter = /^Key[A-Z]$/i.test(code) ? code.slice(3).toUpperCase() : /^[a-z]$/i.test(key) ? key.toUpperCase() : "";
    if (cmd && !e.altKey && !e.shiftKey && (letter === "C" || letter === "V")) return false;
    if (code === "F6" || key === "F6" || code === "F12" || key === "F12") return true;
    if (e.altKey && !cmd && letter === "D") return true;
    if (!cmd) return false;
    if (code === "Tab" || key === "Tab") return true;
    if (e.shiftKey && (letter === "T" || letter === "I" || letter === "J" || letter === "C")) return true;
    return !e.altKey && (letter === "T" || letter === "N" || letter === "L" || letter === "W" || letter === "U");
  };
  canvas.onkeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "KeyV" || e.code === "KeyC")) return;
    if (isSeatEscapeChord(e)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    send({ type: "key", event: "keyDown", key: e.key, code: e.code, modifiers: mods(e) });
  };
  canvas.onkeyup = (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "KeyV" || e.code === "KeyC")) return;
    if (isSeatEscapeChord(e)) {
      e.preventDefault();
      return;
    }
    send({ type: "key", event: "keyUp", key: e.key, code: e.code, modifiers: mods(e) });
  };

  if (typeof ResizeObserver !== "undefined") {
    seatResize = new ResizeObserver(() => sendSize());
    seatResize.observe(canvas.parentElement || canvas);
  }
}

async function onTabPaste(e) {
  if (state.view !== "desk" || state.deskMode !== "tab" || !e.clipboardData) return;
  e.preventDefault();
  e.stopPropagation();
  for (const it of Array.from(e.clipboardData.items || [])) {
    if (it.kind === "file" && /^image\/(png|jpeg|jpg|webp)$/i.test(it.type)) {
      const f = it.getAsFile();
      if (!f) continue;
      const mime = it.type === "image/jpg" ? "image/jpeg" : it.type;
      const buf = await f.arrayBuffer();
      setChip("pasting");
      toast("pasting", "image");
      const r = await sendDeskPaste(buf, mime);
      if (r.ok) {
        setChip("image");
        toast("图片已粘贴到输入框", "image");
      } else {
        setChip("waiting");
        toast(r.error || "图片没贴进去");
      }
      return;
    }
  }
  const text = e.clipboardData.getData("text/plain");
  if (!text) {
    toast("点一下输入框再粘贴");
    return;
  }
  setChip("pasting");
  const r = await sendDeskPaste(text, "text/plain; charset=utf-8");
  if (r.ok) setChip("text", text);
  else setChip("waiting");
  toast(r.ok ? "已粘贴" : r.error || "文字没贴进去");
}

function bindDesk() {
  const wait = $("#frame-wait");
  const iframe = $(".frame iframe");
  const canvas = $("#seat-cast");
  const hide = () => wait?.classList.add("gone");
  if (canvas) {
    bindSeatCast();
    bindTabClipboard();
  } else if (iframe) {
    iframe.addEventListener(
      "load",
      () => {
        try {
          bindClipboard(iframe);
        } catch {
          /* clipboard is optional; never block the desktop */
        }
        setTimeout(hide, 400);
      },
      { once: true },
    );
    setTimeout(hide, 8000);
  } else {
    return;
  }
  lastPeeked = "";
  setChip();
  const chip = $("#clip-chip");
  if (chip)
    chip.onclick = async () => {
      if (!lastClip) {
        toast(`${MOD}+V 贴进来`);
        return;
      }
      const ok = await copyLastToLocal();
      toast(ok ? lastClip.kind === "image" ? "图片已拷到本机" : "已拷到本机" : "没拷出去，再点一次", lastClip.kind);
    };
  const uploadBtn = $("#upload-files");
  if (uploadBtn)
    uploadBtn.onclick = async () => {
      const list = await pickOsFiles({ multiple: true });
      if (!list.length) return;
      const r = await sendOsFiles(list);
      toast(r.ok ? "已添加到对话" : r.error || "无法上传文件");
    };
  bindDeskFileDrop();
  if (state.deskMode === "vnc") startChooserPoll();
  else stopChooserPoll();
  const shareBtn = $("#share-chat");
  if (shareBtn)
    shareBtn.onclick = async () => {
      if (!state.deskId) return;
      shareBtn.disabled = true;
      setChip("copying");
      try {
        const r = await fetch(`/api/desks/${state.deskId}/share`, { method: "POST", credentials: "same-origin" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "分享失败");
        if (data.url) {
          await adoptDeskText(data.url);
        } else {
          setChip("waiting");
          toast("点了分享，但还没拿到链接。再试一次，或在页面里点 Copy link");
        }
      } catch (err) {
        setChip("waiting");
        toast(err.message || "分享失败");
      } finally {
        shareBtn.disabled = false;
      }
    };
  if (deskCdpOn(state.deskId)) ensureWorkspace();
  stopPeek();
  peekTimer = setInterval(async () => {
    if (state.view !== "desk" || !state.deskId) return;
    try {
      const r = await fetch(`/api/desks/${state.deskId}/peek`, { credentials: "same-origin" });
      if (r.status === 401 && state.me) {
        state.me = null;
        setHash("/login");
        return;
      }
      if (!r.ok) return;
      const mime = r.headers.get("content-type") || "";
      if (!mime.startsWith("text/")) return;
      const text = (await r.text()).trim();
      if (isShareLink(text)) await adoptDeskText(text);
    } catch {
      /* ignore */
    }
  }, 2000);
}

function ensureOsFileInput() {
  let el = $("#os-files");
  if (el) return el;
  el = document.createElement("input");
  el.type = "file";
  el.id = "os-files";
  el.multiple = true;
  el.hidden = true;
  el.accept = ".pdf,.doc,.docx,.txt,image/*";
  document.body.appendChild(el);
  return el;
}

function pickOsFiles({ multiple = true } = {}) {
  const el = ensureOsFileInput();
  el.multiple = !!multiple;
  el.value = "";
  return new Promise((resolve) => {
    let done = false;
    const finish = (list) => {
      if (done) return;
      done = true;
      window.removeEventListener("focus", onFocus);
      el.onchange = null;
      resolve(Array.from(list || []));
    };
    el.onchange = () => finish(el.files);
    const onFocus = () => setTimeout(() => finish(el.files), 400);
    window.addEventListener("focus", onFocus, { once: true });
    el.click();
  });
}

function bytesToB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const chunk = 0x2000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function postDeskFiles(payload) {
  const id = state.deskId;
  if (!id) return { ok: false, error: "无法上传文件" };
  const r = await fetch(`/api/desks/${id}/files`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data.error || "无法上传文件" };
  return { ok: true, kind: data.kind };
}

async function sendOsFiles(fileList, extra = {}) {
  const files = [];
  let total = 0;
  for (const f of fileList) {
    total += f.size || 0;
    if (total > 12 * 1024 * 1024) return { ok: false, error: "文件太大，请选择 12MB 以内的文件" };
    const buf = await f.arrayBuffer();
    files.push({
      name: f.name,
      mime: f.type || "application/octet-stream",
      data: bytesToB64(buf),
    });
  }
  setChip("pasting");
  const r = await postDeskFiles({ files, ...extra });
  setChip("waiting");
  return r;
}

async function onRemoteFileChooser(mode) {
  const list = await pickOsFiles({ multiple: mode !== "selectSingle" });
  if (!list.length) {
    await postDeskFiles({ cancel: true });
    return;
  }
  const r = await sendOsFiles(list);
  toast(r.ok ? "已添加到对话" : r.error || "无法上传文件");
}

let chooserPoll = 0;

function stopChooserPoll() {
  chooserPoll += 1;
}

async function startChooserPoll() {
  const ticket = ++chooserPoll;
  const id = state.deskId;
  while (ticket === chooserPoll && state.view === "desk" && state.deskId === id && state.deskMode === "vnc") {
    try {
      const r = await fetch(`/api/desks/${id}/file-chooser`, { credentials: "same-origin" });
      if (ticket !== chooserPoll) return;
      if (!r.ok) {
        await new Promise((ok) => setTimeout(ok, 1500));
        continue;
      }
      const data = await r.json().catch(() => ({}));
      if (data.open) await onRemoteFileChooser(data.mode);
    } catch {
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
}

function bindDeskFileDrop() {
  const shield = $("#file-drop-shield");
  if (!shield) return;
  const hasFiles = (e) => [...(e.dataTransfer?.items || [])].some((it) => it.kind === "file");
  shield.ondragover = (e) => e.preventDefault();
  shield.ondragleave = () => shield.classList.remove("on");
  shield.ondrop = (e) => {
    e.preventDefault();
    shield.classList.remove("on");
    const list = Array.from(e.dataTransfer?.files || []);
    if (!list.length) return;
    sendOsFiles(list).then((r) => toast(r.ok ? "已添加到对话" : r.error || "无法上传文件"));
  };
  if (document.documentElement.dataset.gpcFileDrop === "1") return;
  document.documentElement.dataset.gpcFileDrop = "1";
  document.addEventListener("dragenter", (e) => {
    if (state.view !== "desk" || !hasFiles(e)) return;
    $("#file-drop-shield")?.classList.add("on");
  });
}

async function sendDeskPaste(body, mime) {
  const id = state.deskId;
  if (!id) return { ok: false, error: "无法粘贴" };
  const r = await fetch(`/api/desks/${id}/paste`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": mime },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: data.error || "无法粘贴" };
  return { ok: true };
}

async function copyFromDesk() {
  const id = state.deskId;
  if (!id) return false;
  setChip("copying");
  const r = await fetch(`/api/desks/${id}/copy`, { method: "POST", credentials: "same-origin" });
  if (!r.ok) {
    setChip("waiting");
    toast("没复制到");
    return false;
  }
  const mime = r.headers.get("content-type") || "text/plain";
  const buf = await r.arrayBuffer();
  if (mime.startsWith("image/")) {
    const blob = new Blob([buf], { type: mime });
    const file = new File([blob], "image.png", { type: mime });
    if (lastThumb) URL.revokeObjectURL(lastThumb);
    lastThumb = URL.createObjectURL(file);
    lastClip = { kind: "image", body: buf, mime, text: "", thumb: lastThumb };
    setChip("image");
    const ok = await writeToLocal("", blob);
    toast(ok ? "图片已复制到本机" : "已记下图片，点顶栏图标拷到本机", "image");
    return ok;
  }
  const text = new TextDecoder().decode(buf);
  if (!text) {
    setChip("waiting");
    toast("没有选中的内容");
    return false;
  }
  lastClip = { kind: "text", body: text, mime: "text/plain; charset=utf-8", text, thumb: "" };
  setChip("text", text);
  const ok = await writeToLocal(text, null);
  const preview = text.replace(/\s+/g, " ").trim().slice(0, 18);
  toast(ok ? `已复制到本机「${preview}${text.trim().length > 18 ? "…" : ""}」` : "已记下，点顶栏即可拷到本机");
  return ok;
}

function bindClipboard(iframe) {
  let win;
  let doc;
  try {
    win = iframe.contentWindow;
    doc = iframe.contentDocument;
  } catch {
    return;
  }
  if (!win || !doc?.documentElement || !doc.body) return;
  if (doc.documentElement.dataset.gpcClip === "1") return;
  doc.documentElement.dataset.gpcClip = "1";

  const st = doc.createElement("style");
  st.textContent =
    "#noVNC_keyboardinput{width:2px!important;height:2px!important;opacity:.01!important;overflow:hidden!important;}";
  (doc.head || doc.documentElement).appendChild(st);

  const remember = (kind, body, mime, text, file) => {
    if (lastThumb) URL.revokeObjectURL(lastThumb);
    lastThumb = file ? URL.createObjectURL(file) : "";
    lastClip = { kind, body, mime, text, thumb: lastThumb };
    setChip(kind, text);
  };

  const fromClipboardEvent = async (cd) => {
    if (!cd) return false;
    for (const it of Array.from(cd.items || [])) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (!f) continue;
        const mime = f.type || "image/png";
        const buf = await f.arrayBuffer();
        remember("image", buf, mime, "", f);
        setChip("pasting");
        toast("pasting", "image");
        const pasted = await sendDeskPaste(buf, mime);
        if (pasted.ok) setChip("image");
        else setChip("waiting");
        toast(pasted.ok ? "图片已粘贴到输入框" : pasted.error || "图片没贴进去，点顶栏再试", "image");
        return pasted.ok;
      }
    }
    const text = cd.getData("text/plain");
    if (text) {
      remember("text", text, "text/plain; charset=utf-8", text, null);
      setChip("pasting");
      const pasted = await sendDeskPaste(text, "text/plain; charset=utf-8");
      if (pasted.ok) setChip("text", text);
      else setChip("waiting");
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 18);
      toast(pasted.ok ? `已粘贴「${preview}${text.trim().length > 18 ? "…" : ""}」` : pasted.error || "文字没贴进去");
      return pasted.ok;
    }
    return false;
  };

  const isPasteChord = (e) =>
    (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "KeyV" || e.key === "v" || e.key === "V");
  const isCopyChord = (e) =>
    (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "KeyC" || e.key === "c" || e.key === "C");

  win.addEventListener(
    "keydown",
    (e) => {
      if (isCopyChord(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        copyFromDesk().catch(() => {});
        return;
      }
      if (!isPasteChord(e)) return;
      const kb = doc.getElementById("noVNC_keyboardinput");
      if (kb) kb.focus();
      e.stopImmediatePropagation();
    },
    true,
  );

  const onPaste = (e) => {
    if (state.view !== "desk" || !e.clipboardData) return;
    e.preventDefault();
    e.stopPropagation();
    fromClipboardEvent(e.clipboardData).catch(() => {});
  };
  win.addEventListener("paste", onPaste, true);
  document.addEventListener("paste", onPaste, true);

  let pendingLocal = "";
  const takeRemote = (text) => {
    if (!text || lastClip?.text === text) return;
    pendingLocal = text;
    remember("text", text, "text/plain; charset=utf-8", text, null);
    navigator.clipboard?.writeText(text).catch(() => {});
  };
  win.addEventListener(
    "pointerdown",
    () => {
      if (!pendingLocal) return;
      const t = pendingLocal;
      pendingLocal = "";
      const tmp = doc.createElement("textarea");
      tmp.value = t;
      tmp.style.cssText = "position:fixed;left:-9999px";
      doc.body.appendChild(tmp);
      tmp.select();
      doc.execCommand("copy");
      tmp.remove();
    },
    true,
  );

  const hookRfb = () => {
    const rfb = win.UI?.rfb;
    if (!rfb || rfb._gpcHooked) return;
    rfb._gpcHooked = true;
    try {
      rfb.clipboardUp = true;
      rfb.clipboardDown = true;
    } catch {
      /* ignore */
    }
    try {
      rfb.addEventListener("clipboard", (ev) => takeRemote(ev.detail?.text || ""));
    } catch {
      /* ignore */
    }
  };
  hookRfb();
  const iv = setInterval(hookRfb, 400);
  setTimeout(() => clearInterval(iv), 20000);
}

const workspaceBusy = new Set();

async function ensureWorkspace() {
  const id = state.deskId;
  const key = `${state.me?.id || ""}:${id || ""}`;
  if (!id || !state.me || workspaceBusy.has(key)) return;
  workspaceBusy.add(key);
  try {
    for (let i = 0; i < 12; i++) {
      if (state.view !== "desk" || state.deskId !== id) return;
      try {
        const r = await api(`/api/desks/${id}/onboard`, { method: "POST" });
        if (state.me) {
          state.me.projectDesks = { ...(state.me.projectDesks || {}), [id]: true };
          state.me.projectReady = true;
          state.me.projectName = r.name || state.me.username;
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
  } finally {
    workspaceBusy.delete(key);
  }
}

function bindTabClipboard() {
  if (document.documentElement.dataset.gpcTabClip === "1") return;
  document.documentElement.dataset.gpcTabClip = "1";
  const isCopyChord = (e) =>
    (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.code === "KeyC" || e.key === "c" || e.key === "C");
  document.addEventListener(
    "keydown",
    (e) => {
      if (state.view !== "desk" || state.deskMode !== "tab") return;
      if (!isCopyChord(e)) return;
      e.preventDefault();
      copyFromDesk().catch(() => {});
    },
    true,
  );
  document.addEventListener("paste", onTabPaste, true);
}

async function openDesk(id) {
  const r = await api(`/api/desks/${id}/open`, { method: "POST" });
  state.deskMode = r.mode || "vnc";
  state.seatId = r.seat?.id || null;
  setHash(`/desk/${id}`);
}

async function onDeleteDesk(e) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  const id = btn.getAttribute("data-delete");
  const name = btn.getAttribute("data-delete-name") || "这个账号";
  if (!id) return;
  const live = btn.getAttribute("data-delete-live") === "1";
  const warn = live ? "当前有人正在使用，删除后对方会断开。" : "";
  if (!confirm(`确定删除「${name}」？该桌面会被拆除，上面的 ChatGPT 登录态一并清除。${warn}`)) return;
  try {
    await api(`/api/admin/desks/${id}`, { method: "DELETE" });
    toast(`已删除 ${name}`);
    if (state.deskId === id) setHash("/");
    await refresh();
  } catch (err) {
    toast(err.message || "未能删除");
  }
}

function bind() {
  const logout = $("#logout");
  if (logout) logout.onclick = onLogout;
  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.onclick = onDeleteDesk;
  });
  document.querySelectorAll("[data-open]").forEach((btn) => {
    btn.onclick = (e) => {
      if (e.target.closest("[data-kick],[data-delete]")) return;
      openDesk(btn.getAttribute("data-open"));
    };
    btn.onkeydown = (e) => {
      if (e.key === "Enter" && e.target === btn) openDesk(btn.getAttribute("data-open"));
    };
  });
  document.querySelectorAll("[data-add-desk]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      state.create = true;
      render();
    };
    btn.onkeydown = (e) => {
      if (e.key === "Enter" && e.target === btn) {
        state.create = true;
        render();
      }
    };
  });
  const cCancel = $("#create-cancel");
  if (cCancel)
    cCancel.onclick = () => {
      state.create = false;
      render();
    };
  const cMask = $("#create-mask");
  if (cMask)
    cMask.onclick = (e) => {
      if (e.target === cMask) {
        state.create = false;
        render();
      }
    };
  const cForm = $("#create-form");
  if (cForm)
    cForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(cForm);
      const submit = cForm.querySelector("[type=submit]");
      if (submit) {
        submit.disabled = true;
        submit.textContent = "正在启动…";
      }
      try {
        await api("/api/admin/desks", { method: "POST", body: { name: fd.get("name") } });
        state.create = false;
        toast("新账号已启动，打开卡片登录 ChatGPT");
        await refresh();
      } catch (err) {
        const box = $("#create-err");
        if (box) box.textContent = err.message;
        if (submit) {
          submit.disabled = false;
          submit.textContent = "添加";
        }
      }
    };
  const add = $("#add-user");
  if (add)
    add.onclick = () => {
      state.modal = true;
      render();
    };
  const cancel = $("#cancel");
  if (cancel)
    cancel.onclick = () => {
      state.modal = false;
      render();
    };
  const mask = $("#modal");
  if (mask)
    mask.onclick = (e) => {
      if (e.target === mask) {
        state.modal = false;
        render();
      }
    };
  const form = $("#user-form");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api("/api/admin/users", {
          method: "POST",
          body: { username: fd.get("username"), password: fd.get("password"), desks: fd.getAll("desks") },
        });
        state.modal = false;
        await refresh();
      } catch (err) {
        $("#err").textContent = err.message;
      }
    };
  document.querySelectorAll("[data-rename]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      state.rename = btn.getAttribute("data-rename");
      render();
    };
  });
  const rCancel = $("#rename-cancel");
  if (rCancel)
    rCancel.onclick = () => {
      state.rename = null;
      render();
    };
  const rMask = $("#rename-mask");
  if (rMask)
    rMask.onclick = (e) => {
      if (e.target === rMask) {
        state.rename = null;
        render();
      }
    };
  const rForm = $("#rename-form");
  if (rForm)
    rForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(rForm);
      try {
        await api(`/api/admin/desks/${state.rename}`, { method: "PATCH", body: { name: fd.get("name") } });
        state.rename = null;
        await refresh();
      } catch (err) {
        $("#rename-err").textContent = err.message;
      }
    };
  document.querySelectorAll("[data-manage]").forEach((btn) => {
    btn.onclick = () => {
      state.manage = btn.getAttribute("data-manage");
      render();
    };
  });
  const mCancel = $("#manage-cancel");
  if (mCancel)
    mCancel.onclick = () => {
      state.manage = null;
      render();
    };
  const mMask = $("#manage-mask");
  if (mMask)
    mMask.onclick = (e) => {
      if (e.target === mMask) {
        state.manage = null;
        render();
      }
    };
  const mForm = $("#manage-form");
  if (mForm)
    mForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(mForm);
      try {
        await api(`/api/admin/users/${state.manage}`, { method: "PATCH", body: { desks: fd.getAll("desks") } });
        state.manage = null;
        await refresh();
      } catch (err) {
        $("#manage-err").textContent = err.message;
      }
    };
  document.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.getAttribute("data-name") || "这位成员";
      if (!confirm(`确定移除 ${name}？对方将无法再登录。`)) return;
      await api(`/api/admin/users/${btn.getAttribute("data-del")}`, { method: "DELETE" });
      await refresh();
    };
  });
  document.querySelectorAll("[data-proxy-pick]").forEach((btn) => {
    btn.onclick = () => {
      const url = btn.getAttribute("data-proxy-pick") || "";
      const all = $("#proxy-all-input");
      if (all) all.value = url;
      document.querySelectorAll("[data-proxy-input]").forEach((input) => {
        input.value = url;
      });
    };
  });
  document.querySelectorAll("[data-proxy-save]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-proxy-save");
      const input = document.querySelector(`[data-proxy-input="${CSS.escape(id)}"]`);
      if (!input) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/desks/${id}`, { method: "PATCH", body: { proxy: input.value } });
        toast(input.value.trim() ? "代理已更新，该账号浏览器正在重启" : "已恢复默认出口，该账号浏览器正在重启");
        await refresh();
      } catch (err) {
        toast(err.message || "没保存成功");
        if (String(err.message || "").includes("已保存")) await refresh();
        else btn.disabled = false;
      }
    };
  });
  const proxyAll = $("#proxy-all");
  if (proxyAll)
    proxyAll.onclick = async () => {
      const input = $("#proxy-all-input");
      if (!input) return;
      proxyAll.disabled = true;
      try {
        await api("/api/admin/proxies", { method: "POST", body: { proxy: input.value } });
        toast(input.value.trim() ? "已应用到全部账号，各浏览器正在重启" : "已恢复全部账号的默认出口，浏览器正在重启");
        await refresh();
      } catch (err) {
        toast(err.message || "没保存成功");
        if (String(err.message || "").includes("已保存")) await refresh();
        else proxyAll.disabled = false;
      }
    };
  document.querySelectorAll("[data-invite-empty]").forEach((btn) => {
    btn.onclick = () => {
      state.modal = true;
      render();
    };
  });
  document.querySelectorAll("[data-assign]").forEach((btn) => {
    btn.onclick = () => {
      state.assign = btn.getAttribute("data-assign");
      render();
    };
  });
  const aCancel = $("#assign-cancel");
  if (aCancel)
    aCancel.onclick = () => {
      state.assign = null;
      render();
    };
  const aMask = $("#assign-mask");
  if (aMask)
    aMask.onclick = (e) => {
      if (e.target === aMask) {
        state.assign = null;
        render();
      }
    };
  const aForm = $("#assign-form");
  if (aForm)
    aForm.onsubmit = async (e) => {
      e.preventDefault();
      const deskId = state.assign;
      const picked = new Set(new FormData(aForm).getAll("users"));
      try {
        for (const u of state.users) {
          if (u.role === "admin") continue;
          const has = (u.desks || []).includes(deskId);
          const want = picked.has(u.id);
          if (has === want) continue;
          const desks = want ? [...(u.desks || []), deskId] : (u.desks || []).filter((id) => id !== deskId);
          await api(`/api/admin/users/${u.id}`, { method: "PATCH", body: { desks } });
        }
        state.assign = null;
        await refresh();
      } catch (err) {
        const box = $("#assign-err");
        if (box) box.textContent = err.message;
      }
    };
  document.querySelectorAll("[data-kick-desk]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-kick-desk");
      const name = btn.getAttribute("data-kick-name") || "这个账号";
      const vs = people(id).filter((v) => v.id && v.id !== state.me?.id);
      if (!vs.length) return;
      if (!confirm(`断开「${name}」上的 ${vs.map((v) => v.username).join("、")}？对方需要重新登录。`)) return;
      btn.disabled = true;
      try {
        for (const v of vs) await api(`/api/admin/users/${v.id}/kick`, { method: "POST" });
        toast("已断开");
        await refresh();
      } catch (err) {
        toast(err.message || "未能断开");
        btn.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-toggle");
      const disabled = btn.getAttribute("data-disabled") === "1";
      const name = btn.getAttribute("data-name") || "这位成员";
      if (!disabled && !confirm(`停用 ${name}？已有会话立即失效。`)) return;
      try {
        await api(`/api/admin/users/${id}`, { method: "PATCH", body: { disabled: !disabled } });
        toast(disabled ? `已启用 ${name}` : `已停用 ${name}`);
        await refresh();
      } catch (err) {
        toast(err.message || "没能保存");
      }
    };
  });
  document.querySelectorAll("[data-resetpw]").forEach((btn) => {
    btn.onclick = () => {
      state.resetPw = btn.getAttribute("data-resetpw");
      render();
    };
  });
  const pCancel = $("#resetpw-cancel");
  if (pCancel)
    pCancel.onclick = () => {
      state.resetPw = null;
      render();
    };
  const pMask = $("#resetpw-mask");
  if (pMask)
    pMask.onclick = (e) => {
      if (e.target === pMask) {
        state.resetPw = null;
        render();
      }
    };
  const pForm = $("#resetpw-form");
  if (pForm)
    pForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(pForm);
      try {
        await api(`/api/admin/users/${state.resetPw}`, { method: "PATCH", body: { password: fd.get("password") } });
        state.resetPw = null;
        toast("密码已重置");
        await refresh();
      } catch (err) {
        $("#resetpw-err").textContent = err.message;
      }
    };
  const selfBtn = $("#self-pw");
  if (selfBtn)
    selfBtn.onclick = () => {
      state.selfPw = true;
      render();
    };
  const sCancel = $("#selfpw-cancel");
  if (sCancel)
    sCancel.onclick = () => {
      state.selfPw = false;
      render();
    };
  const sMask = $("#selfpw-mask");
  if (sMask)
    sMask.onclick = (e) => {
      if (e.target === sMask) {
        state.selfPw = false;
        render();
      }
    };
  const sForm = $("#selfpw-form");
  if (sForm)
    sForm.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(sForm);
      try {
        await api(`/api/admin/users/${state.me.id}`, { method: "PATCH", body: { password: fd.get("password") } });
        state.selfPw = false;
        state.me = null;
        toast("密码已修改，请重新登录");
        setHash("/login");
        render();
      } catch (err) {
        $("#selfpw-err").textContent = err.message;
      }
    };
}

async function onLogin(e) {
  e.preventDefault();
  state.err = "";
  const fd = new FormData(e.target);
  try {
    const { user } = await api("/api/login", {
      method: "POST",
      body: { username: fd.get("username"), password: fd.get("password") },
    });
    state.me = user;
    await refresh();
    setHash("/");
  } catch (err) {
    state.err = err.message;
    render();
  }
}

async function refresh() {
  const [me, desks, presence] = await Promise.all([api("/api/me"), api("/api/desks"), api("/api/presence")]);
  state.me = me.user;
  state.settings = me.settings || {};
  state.desks = desks.desks;
  state.proxyPresets = desks.proxyPresets || [];
  state.seatCap = desks.seatCap || state.seatCap || 3;
  state.presence = presence.presence || {};
  if (state.me.role === "admin") state.users = (await api("/api/admin/users")).users;
  state.boot = false;
  render();
}

async function tick() {
  if (!state.me) return;
  try {
    if (state.view === "desk" && state.deskId) {
      const r = await api("/api/presence/beat", { method: "POST", body: { deskId: state.deskId } });
      state.presence[state.deskId] = r.viewers || [];
      const who = $(".who");
      if (who) {
        const names = (r.viewers || []).map((v) => v.username).join("、");
        who.textContent = names;
        who.hidden = !names;
      }
    } else if (!state.modal && !state.manage && !state.rename && !state.create && !state.assign && !state.resetPw && !state.selfPw) {
      const r = await api("/api/presence");
      state.presence = r.presence || {};
      if (state.view === "home" || state.view === "admin") render();
    }
  } catch {
    /* ignore */
  }
}

window.addEventListener("hashchange", () => {
  const leavingDesk = state.view === "desk" && !location.hash.replace(/^#/, "").startsWith("/desk/");
  route();
  if (leavingDesk) dropPresence();
  render();
});

(async function boot() {
  route();
  render();
  try {
    const s = await api("/api/setup");
    if (s.needed) {
      state.setup = true;
      state.boot = false;
      render();
      setInterval(tick, 5000);
      return;
    }
  } catch {
    /* 网关旧版本没有这个接口时按已初始化处理 */
  }
  try {
    await refresh();
    if (state.view === "login") setHash("/");
  } catch {
    state.me = null;
    state.boot = false;
    setHash("/login");
    render();
  }
  setInterval(tick, 5000);
})();
