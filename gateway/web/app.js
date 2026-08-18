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

const state = { me: null, desks: [], presence: {}, users: [], settings: { assist: false }, proxyPresets: [], view: "home", deskId: null, err: "", modal: false, manage: null, rename: null, create: false, setup: false, boot: true };

function assistOn() {
  return !!state.settings?.assist;
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

function kickBtn(id, name) {
  return `<button type="button" class="m-kick" data-kick="${esc(id)}" data-kick-name="${esc(name)}">断开</button>`;
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
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.5 5.5 9 12l6.5 6.5-1.4 1.4L6.2 12l7.9-7.9 1.4 1.4Z"/></svg>`,
  image: `<svg class="ico-img" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm1.2 13h11.6l-3.4-4.6-2.6 3.3-2.2-2.6L6.2 17ZM8 9.2A1.6 1.6 0 1 0 8 6a1.6 1.6 0 0 0 0 3.2Z"/></svg>`,
  share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14V4ZM6 6h5v2H7.8A1.8 1.8 0 0 0 6 9.8v6.4C6 17.2 6.8 18 7.8 18h6.4c1 0 1.8-.8 1.8-1.8V13h2v3.2A3.8 3.8 0 0 1 14.2 20H7.8A3.8 3.8 0 0 1 4 16.2V9.8A3.8 3.8 0 0 1 7.8 6H11V6H6Z"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13.2 5.3 18.9 11l.9 1-.9 1-5.7 5.7-1.4-1.4 4.3-4.3H4v-2h12.1l-4.3-4.3 1.4-1.4Z"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.06 6.19l3.75 3.75L7.5 20.25H3.75V16.5L14.06 6.19Zm1.41-1.41 1.83-1.83a1 1 0 0 1 1.41 0l2.34 2.34a1 1 0 0 1 0 1.41l-1.83 1.83-3.75-3.75Z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z"/></svg>`,
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
      <label class="field"><span>用户名</span><input name="username" autocomplete="username" autofocus required></label>
      <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn lg block" type="submit">登录</button>
    </form>
    <p class="auth-foot">账号由管理员分配，如需开通请联系管理员</p>
  </div>`;
}

function renderSetup() {
  return `<div class="auth">
    <div class="auth-brand">${MARK}<span>GPT&#8209;Pro Cloud</span></div>
    <form class="auth-card" id="setup-form">
      <h1>创建管理员</h1>
      <p class="hint">首次部署：设置管理员账号，之后用它登录并邀请成员</p>
      <div class="err" id="err"></div>
      <label class="field"><span>用户名</span><input name="username" autocomplete="off" maxlength="32" autofocus required></label>
      <label class="field"><span>密码</span><input name="password" type="password" autocomplete="new-password" minlength="6" required></label>
      <label class="field"><span>确认密码</span><input name="password2" type="password" autocomplete="new-password" minlength="6" required></label>
      <button class="btn lg block" type="submit">创建并登录</button>
    </form>
    <p class="auth-foot">这个向导只在还没有管理员时出现</p>
  </div>`;
}

async function onSetup(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  const p1 = String(fd.get("password") || "");
  if (p1 !== String(fd.get("password2") || "")) {
    $("#err").textContent = "两次输入的密码不一致";
    return;
  }
  try {
    const { user } = await api("/api/setup", { method: "POST", body: { username: fd.get("username"), password: p1 } });
    state.setup = false;
    state.me = user;
    await refresh();
    setHash("/");
  } catch (err) {
    $("#err").textContent = err.message;
  }
}

function shell(inner) {
  const team =
    state.me?.role === "admin"
      ? `<a href="#/admin" class="top-link ${state.view === "admin" ? "on" : ""}">团队</a>
         <a href="#/settings" class="top-link ${state.view === "settings" ? "on" : ""}">设置</a>
         <span class="top-sep"></span>`
      : "";
  return `<div class="app">
    <header class="top">
      <a href="#/" class="brand">${MARK}<span>GPT&#8209;Pro Cloud</span></a>
      ${team}
      <span class="top-user">${av(state.me?.username)}<b>${esc(state.me?.username)}</b></span>
      <button type="button" class="text-btn" id="logout">退出</button>
    </header>
    <main class="page">${inner}</main>
  </div>`;
}

function renderHome() {
  const name = esc(state.me?.username || "");
  const head = `<header class="page-head">
    <h1 class="display">${greet()}，${name}</h1>
    <p class="hint">${state.desks.length ? "选择一个 ChatGPT 账号开始使用。" : "还没有可使用的账号，请联系管理员开通。"}</p>
  </header>`;
  const isAdmin = state.me?.role === "admin";
  const cards = state.desks
    .map((d) => {
      const vs = people(d.id);
      const live = vs.length > 0;
      const stack = vs
        .slice(0, 4)
        .map((v) => av(v.username, "av mini"))
        .join("");
      const names = vs.map((v) => v.username).join("、");
      const kicks = isAdmin
        ? vs
            .filter((v) => v.id && v.id !== state.me?.id)
            .map((v) => kickBtn(v.id, v.username))
            .join("")
        : "";
      const users = live
        ? `<span class="m-users"><span class="stack">${stack}</span><span>${esc(names)}</span>${kicks}</span>`
        : `<span class="m-users"><span>无人使用</span></span>`;
      const pencil = isAdmin
        ? `<button type="button" class="m-rename" data-rename="${esc(d.id)}" aria-label="重命名">${ICO.pencil}</button>`
        : "";
      const del = isAdmin && d.extra
        ? `<button type="button" class="m-kick" data-delete="${esc(d.id)}" data-delete-name="${esc(d.name)}" data-delete-live="${live ? "1" : ""}">删除</button>`
        : "";
      return `<div class="machine" data-open="${esc(d.id)}" role="button" tabindex="0">
        <span class="m-body">
          <span class="m-head">
            <span class="m-mark">${BLOOM}</span>
            <span class="badge ${live ? "live" : ""}"><i class="status-dot"></i>${live ? "使用中" : "空闲"}</span>
          </span>
          <span class="m-name">${esc(d.name)}${pencil}</span>
        </span>
        <span class="m-foot">
          ${users}
          ${del}
          <span class="m-go">进入${ICO.arrow}</span>
        </span>
      </div>`;
    })
    .join("");
  const addCard = isAdmin
    ? `<div class="machine add" data-add-desk role="button" tabindex="0">
        <span class="m-body">
          <span class="m-head">
            <span class="m-mark plus">${ICO.plus}</span>
          </span>
          <span class="m-name">添加 ChatGPT 账号</span>
        </span>
        <span class="m-foot">
          <span class="m-users"><span>启动一台新的桌面</span></span>
          <span class="m-go">添加${ICO.arrow}</span>
        </span>
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
  const createModal = state.create
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
  const grid = cards || addCard ? `<div class="machines">${cards}${addCard}</div>` : "";
  return shell(`${head}${grid}${renameModal}${createModal}`);
}

function renderAdmin() {
  if (state.me?.role !== "admin") return renderHome();
  const rows = state.users
    .map((u) => {
      const chips = (u.desks || []).map((id) => `<span class="chip">${esc(deskName(id))}</span>`).join("");
      const on = occupancy(u);
      const liveChip = on.length
        ? `<span class="chip live">${esc(on.map(deskName).join("、"))} · 使用中</span>`
        : "";
      const actions =
        u.role === "admin"
          ? ""
          : `<button type="button" class="text-btn" data-manage="${esc(u.id)}">管理</button>
             <button type="button" class="text-btn danger" data-del="${esc(u.id)}" data-name="${esc(u.username)}">移除</button>`;
      const role = u.role === "admin" ? "管理员" : "成员";
      const where = on.length ? ` · 正在使用 ${esc(on.map(deskName).join("、"))}` : "";
      return `<article class="person ${u.disabled ? "off" : ""}">
        <div class="person-who">${av(u.username)}<div class="person-id"><b>${esc(u.username)}</b><span>${role}${where}${u.disabled ? ` · <i class="off-note">已停用</i>` : ""}</span></div></div>
        <div class="access">${liveChip}${chips || (liveChip ? "" : `<span class="none">未分配账号</span>`)}</div>
        <div class="person-actions">${actions}</div>
      </article>`;
    })
    .join("");
  const checks = state.desks
    .map((d) => `<label class="pick"><input type="checkbox" name="desks" value="${esc(d.id)}" checked> ${esc(d.name)}</label>`)
    .join("");
  const modal = state.modal
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
          <h2>管理成员</h2>
          <p class="hint">调整 ${esc(mu.username)} 的账号权限与登录设置。</p>
          <div class="err" id="manage-err"></div>
          <div class="field">
            <span>可使用</span>
            <div class="picks">${manageChecks}</div>
          </div>
          <label class="field"><span>重置密码</span><input name="password" type="password" autocomplete="new-password" minlength="6" placeholder="留空则不修改"></label>
          <label class="pick block-pick"><input type="checkbox" name="disabled" ${mu.disabled ? "checked" : ""}> 停用登录（已有会话立即失效）</label>
          <div class="sheet-actions">
            <button class="btn ghost" type="button" id="manage-cancel">取消</button>
            <button class="btn" type="submit">保存</button>
          </div>
        </form>
      </div>`
    : "";
  return shell(`<div class="narrow">
    <header class="page-head split">
      <div>
        <h1 class="display">团队</h1>
        <p class="hint">管理谁可以登录、能用哪些账号。谁在使用某台桌面，请到首页账号卡片上断开。</p>
      </div>
      <button type="button" class="btn" id="add-user">邀请成员</button>
    </header>
    <section class="panel">
      <div class="people">${rows}</div>
    </section>
  </div>${modal}${manageModal}`);
}

function sharedProxyValue() {
  const vals = state.desks.map((d) => d.proxy || "");
  if (vals.length && vals.every((v) => v === vals[0])) return vals[0];
  return state.proxyPresets[0] || "";
}

function renderSettings() {
  if (state.me?.role !== "admin") return renderHome();
  const on = assistOn();
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
      <label class="switch-row">
        <span>
          <b>页面协助</b>
          <em>打开后自动进项目，顶栏可代点分享。会连接浏览器调试口。</em>
        </span>
        <input type="checkbox" id="assist-toggle" ${on ? "checked" : ""}>
      </label>
      <div class="assist-note">
        <b>说明</b>
        <p><b>分享</b> — 关掉时，在 ChatGPT 页面里自己点 Share 并复制，链接会经剪贴板落到本机。打开后，顶栏多一个「分享」按钮，由网关代点，链接直接给你。</p>
        <p><b>记忆隔离</b> — 打开后，成员第一次进入某个账号，会自动进入（或创建）一个以其用户名命名的 ChatGPT 项目，并设为仅项目内记忆。对话不读写账号的全局记忆。</p>
        <p><b>案例</b> — ada 和 bob 共用「老板号」。ada 第一次打开时进入项目「ada」，之后她的对话只写进这个项目；bob 进的是「bob」。两边互不可见，也不会把上下文留给下一个用这个席位的人。</p>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <b>复制粘贴</b>
        <em>桌面嵌在页面里，本机的 Cmd/Ctrl+C / V 不会直接穿过。贴进去：先在本机复制，点进桌面再按 Cmd/Ctrl+V。拷出来：在 ChatGPT 里选中文字或图，按 Cmd/Ctrl+C。浏览器可能询问剪贴板权限；局域网 HTTP 下常常写不进本机剪贴板——这时点顶栏那个格子（会显示刚记下的内容）。文字和截图都可以。不需要去找远端桌面里的剪贴板面板。</em>
      </div>
      <div class="clip-note">
        <p><b>案例</b> — ada 在笔记里复制「请总结上周纪要」，打开「老板号」，按 Cmd+V，输入框出现这句话。选中回复再按 Cmd+C；若提示「已记下」或本机还贴不出来，点一下顶栏格子。</p>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <b>出口代理</b>
        <em>服务器能直连 ChatGPT（如海外机器）就不需要代理，留空即可；服务器在国内等无法直连的网络时必须配置。前置条件：一个服务器可达的 http:// / https:// / socks5:// 代理端点——宿主机上跑的代理客户端填 <code>http://127.0.0.1:7890</code> 这类地址即可，会自动改写为容器可达；也可以填远程代理。填一次后点「全部应用」会下发到每个 ChatGPT 账号，路径与逐行保存相同（立即重启该账号的浏览器）。保存过的地址会出现在上方，点一下就能再用。留空再应用则恢复服务器默认出口。</em>
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
    chip.innerHTML = `<span>${esc(one)}</span>${clipKeys()}`;
    chip.title = "拷到本机";
    return;
  }
  chip.innerHTML = `<i class="pulse"></i><span>waiting</span>${clipKeys()}`;
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
  const src = `/vnc/index.html?autoconnect=1&path=websockify&resize=remote&reconnect=true&reconnect_delay=2000&clipboard_up=true&clipboard_down=true&clipboard_seamless=true`;
  return `<div class="stage">
    <div class="chrome">
      <a class="back" href="#/">${ICO.back}<span>退出</span></a>
      <div class="chrome-mid">
        ${BLOOM}
        <span class="title">${esc(d ? d.name : "ChatGPT")}</span>
        <span class="who" ${names ? "" : "hidden"}>${esc(names)}</span>
      </div>
      <div class="chrome-end">
        ${assistOn() ? `<button type="button" class="chrome-btn" id="share-chat">${ICO.share}<span>分享</span></button>` : ""}
        <button type="button" class="clip-chip" id="clip-chip"></button>
      </div>
    </div>
    <div class="frame">
      <div class="frame-wait" id="frame-wait">${MARK}</div>
      <iframe src="${src}" allow="clipboard-read; clipboard-write; autoplay; microphone"></iframe>
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
  if (!state.me) return;
  const uid = state.me.username;
  for (const id of Object.keys(state.presence)) {
    state.presence[id] = (state.presence[id] || []).filter((v) => v.username !== uid);
  }
  api("/api/presence/leave", { method: "POST", body: {} }).catch(() => {});
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

function bindDesk() {
  const wait = $("#frame-wait");
  const iframe = $(".frame iframe");
  if (!iframe) return;
  const hide = () => wait?.classList.add("gone");
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
  if (assistOn()) ensureWorkspace();
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

async function sendDeskPaste(body, mime) {
  const id = state.deskId;
  if (!id) return false;
  const r = await fetch(`/api/desks/${id}/paste`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": mime },
    body,
  });
  return r.ok;
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
        const ok = await sendDeskPaste(buf, mime);
        if (ok) setChip("image");
        else setChip("waiting");
        toast(ok ? "图片已粘贴到输入框" : "图片没贴进去，点顶栏再试", "image");
        return ok;
      }
    }
    const text = cd.getData("text/plain");
    if (text) {
      remember("text", text, "text/plain; charset=utf-8", text, null);
      setChip("pasting");
      const ok = await sendDeskPaste(text, "text/plain; charset=utf-8");
      if (ok) setChip("text", text);
      else setChip("waiting");
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 18);
      toast(ok ? `已粘贴「${preview}${text.trim().length > 18 ? "…" : ""}」` : "文字没贴进去");
      return ok;
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

async function openDesk(id) {
  await api(`/api/desks/${id}/open`, { method: "POST" });
  setHash(`/desk/${id}`);
}

async function onKick(e) {
  e.preventDefault();
  e.stopPropagation();
  const btn = e.currentTarget;
  const id = btn.getAttribute("data-kick");
  const name = btn.getAttribute("data-kick-name") || "这位成员";
  if (!id) return;
  if (!confirm(`确定断开 ${name} 的会话？对方需要重新登录。`)) return;
  try {
    await api(`/api/admin/users/${id}/kick`, { method: "POST" });
    toast(`已断开 ${name}`);
    await refresh();
  } catch (err) {
    toast(err.message || "未能断开");
  }
}

function bindKick() {
  document.querySelectorAll("[data-kick]").forEach((btn) => {
    btn.onclick = onKick;
  });
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
  bindKick();
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
      const body = { desks: fd.getAll("desks"), disabled: fd.get("disabled") === "on" };
      const pw = String(fd.get("password") || "");
      if (pw) body.password = pw;
      try {
        await api(`/api/admin/users/${state.manage}`, { method: "PATCH", body });
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
  const assist = $("#assist-toggle");
  if (assist)
    assist.onchange = async () => {
      assist.disabled = true;
      try {
        const r = await api("/api/admin/settings", { method: "POST", body: { assist: assist.checked } });
        state.settings = r.settings || { assist: assist.checked };
      } catch (err) {
        assist.checked = assistOn();
        toast(err.message || "没能保存");
      } finally {
        assist.disabled = false;
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
  state.settings = me.settings || { assist: false };
  state.desks = desks.desks;
  state.proxyPresets = desks.proxyPresets || [];
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
    } else if (!state.modal && !state.manage && !state.rename && !state.create) {
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
