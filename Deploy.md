# Deploy.md — GPT-Pro Cloud

## 组成

| 容器 | 说明 |
|---|---|
| `gpt-pro-cloud-gateway` | 唯一入口 `:36090`，登录、账号选择、团队管理、桌面反代 |
| `gpt-pro-cloud-a` / `b` | 内置 ChatGPT 席位，各一只独立 Chromium；DevTools `9222/9223` 不映射宿主机，CDP 转发只接受 gateway |
| `gpt-pro-cloud-<id>` | 面板里添加的额外席位，由 gateway 克隆 `desktop-a`；不写进 compose |

持久化数据都在仓库目录下：`./data/<id>`（Chromium profile 与 ChatGPT 登录态）、`./data-panel/`（成员 `users.json`、会话 `sessions.json`、设置，以及 `extraDeskIds`）。两者都被 gitignore。

## 添加账号

管理员在首页添加 ChatGPT 账号。gateway 需要访问 Docker Engine：compose 已挂载 `/var/run/docker.sock`。拉代码后执行一次 `docker compose up -d` 让挂载生效，之后不必 SSH 改 compose 或 `INSTANCES`。

额外容器不在 compose 服务列表里，但会加入同一个 compose 网络（别名 `desktop-<id>`），`restart: unless-stopped`。网关启动时会按 `users.json` 里的 `extraDeskIds` 把它们拉起来并接到当前网络。

Cloud / CI 虚拟机通常不跑桌面镜像。请在真实 Docker 宿主机上确认：`docker ps` 出现 `gpt-pro-cloud-<id>`，打开新卡片能进 Chromium 并登录 ChatGPT。

## 启动

```bash
cp .env.example .env
# AUTH_PASSWORD 可选：留空则首次访问走向导创建管理员
# BIND_ADDR：内网填局域网/VPN 地址；走 Cloudflare Tunnel 时填 127.0.0.1
./scripts/up.sh
```

打开 `http://127.0.0.1:36090`（或内网地址）完成管理员。公网必须先有管理员再开隧道，见下方。

## 公网：Cloudflare Tunnel

顺序：启动 → 在本机或局域网建好管理员 → 再开隧道。对公网打开时必须是登录页，不能是首次访问向导。

走隧道时 `BIND_ADDR=127.0.0.1`。若面板已经绑在局域网/VPN 地址上，改完再 `docker compose up -d`。

```bash
# 临时域名，不需要自己的域名
cloudflared tunnel --url http://127.0.0.1:36090
```

要固定主机名，把 named tunnel 指到同一个本地端口（需要 Cloudflare 上有域名）。

把打印出的 `https://` 地址发给队友。部署者用已建好的管理员登录；成员用「团队」页创建的网关用户名/密码，不是 ChatGPT 密码。限流与审计会读 `CF-Connecting-IP`。

## 健康检查

```bash
curl -fsS http://127.0.0.1:36090/healthz
```

## 日志

```bash
docker compose logs -f gateway
docker compose logs -f desktop-a
docker logs -f gpt-pro-cloud-<id>   # 面板里加出来的额外桌面
```

## 更新与回滚

更新：开发机 commit → push → 部署机 `git pull && docker compose up -d --build`。

回滚：部署机 `git checkout <旧 commit> && docker compose up -d --build`。`data/` 与 `data-panel/` 不随代码回滚，登录态与成员配置保持不变。
