<div align="center">

<img src="assets/hero.svg" alt="GPT-Pro Cloud —— 把已登录的 ChatGPT Pro 跑在自己的机器上" width="100%">

# GPT-Pro Cloud — 一个 Pro 席位，团队设备通用

[![Docker](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](gateway/)
[![Chromium](https://img.shields.io/badge/chromium-kiosk-4587F3?style=flat-square&logo=googlechrome&logoColor=white)](docker/)
[![KasmVNC](https://img.shields.io/badge/kasmvnc-web_desktop-5257CF?style=flat-square)](https://kasmweb.com/kasmvnc)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-178F5F?style=flat-square)](Deploy.md)
[![License](https://img.shields.io/badge/license-MIT-1a1a18?style=flat-square)](LICENSE)

[English](README.md) | **简体中文**

</div>

---

GPT-Pro Cloud 是一套 Docker 网关加浏览器桌面，把已登录的 ChatGPT 会话跑在你自己的机器上。它面向需要一个 Pro 席位随处可达的个人和小团队：无需安装客户端，也不必再登录一次。

> **免责声明** —— 多人共用 ChatGPT 账号可能违反 OpenAI 的条款与政策。本仓库只提供自托管技术方案；是否使用、如何使用及一切后果由使用者自行承担，与本仓库无关。

<img src="assets/screenshot-home.jpg" alt="账号选择页：两张机器卡片显示实时在线状态、管理员标记和团队管理入口" width="100%">

每个账号独占一个带持久化 profile 的 Chromium。一个网关提供登录、账号选择、团队管理和远程桌面——全部在浏览器里完成。

## 安装

运行环境：Docker Compose（Linux 服务器；macOS / Windows 用 Docker Desktop），每个账号约 1 GB 内存。

```bash
git clone https://github.com/JingxuanKang/GPT-Pro-Cloud.git
cd gpt-pro-cloud
cp .env.example .env
./scripts/up.sh
```

请部署在局域网或 Tailscale 这类 VPN 内。面板走明文 HTTP，见[安全](#安全)。

## 快速开始

打开 `http://<host>:36090`，首次访问会引导你创建管理员账号（也可以在 `.env` 里用 `AUTH_PASSWORD` 预设，适合自动化部署）。然后逐个打开账号卡片，在里面登录 ChatGPT——profile 跨重启保留，所以每个账号只需要做这一次。

之后同一网络里的任何设备打开同一个地址，进去就是已登录的会话。

## 添加账号

一个 ChatGPT 账号对应一个桌面容器。

1. 在 `docker-compose.yml` 里复制一个 `desktop-*` 服务，卷挂载 `./data/<id>:/config`。
2. 把 id 追加到 `.env` 的 `INSTANCES`。
3. 执行 `docker compose up -d --build`，打开新卡片登录一次。

## 团队与权限

成员在「团队」页管理，该页仅管理员可见。

| 目标 | 操作 |
| --- | --- |
| 新增成员 | 邀请后指定其可打开的账号 |
| 重置凭证 | 重置该成员密码，其会话同时失效 |
| 收回权限 | 停用或删除成员，在线会话立即断开 |
| 查看占用 | 机器卡片按账号显示实时在线状态 |

密码以逐用户加盐的 scrypt 哈希存储。登录按 `ip|用户名` 限流（15 分钟 10 次），会话跨重启保留。

## 剪贴板

剪贴板是双向的，沿用你已经习惯的快捷键：在本机复制，粘贴进远端 Chromium，反向同样可用。文字和截图都支持。

## 分享与记忆隔离

分享对话有两条路。基础路径不依赖任何自动化：在页面里点 ChatGPT 自带的 Share 并复制，链接会经剪贴板链路自动落到你本机。开启**页面协助**后，顶栏会多一个「分享」按钮，由网关代点并直接把链接拷给你。

记忆隔离解决"共用账号但不共用上下文"：开启页面协助后，成员第一次进入某个账号，网关会自动创建（或进入）一个以其用户名命名、设为**仅项目内记忆**的 ChatGPT 项目。项目内的对话不读写账号的全局记忆，成员之间互不泄漏上下文，每人的对话也归拢在各自的项目里。

页面协助默认关闭。它靠 DevTools 选择器驱动 chatgpt.com，OpenAI 改版后可能失效；关掉时分享自己点、链接照样拷到本机，但不做自动进项目。

## 配置

全部配置在 `.env`，带注释的 [`.env.example`](.env.example) 就是参考。

| 配置项 | 作用 |
| --- | --- |
| `AUTH_PASSWORD` | 可选：预设管理员密码，留空走首次访问向导 |
| `INSTANCES` | 逗号分隔的桌面 id，决定显示哪些卡片 |
| `BIND_ADDR` | 网关监听地址；公网机器填 VPN 地址 |
| `PROXY_URL_A`、`PROXY_URL_B` | 按账号出口代理的默认值；「设置」页里的修改优先且立即生效 |
| `PROXY_URL` | 所有账号共用的默认代理 |

## 架构

```
浏览器 ──▶ gateway (:36090) ──▶ desktop-a / desktop-b
           登录 · 选账号 · 团队      Chromium --kiosk chatgpt.com
```

网关是唯一发布的端口。VNC 与 Chromium DevTools 留在容器网络里，从外部不可达。状态存在 `./data/`（Chromium profile）和 `./data-panel/`（成员、会话、设置），两者都被 gitignore，不出本机。

## 安全

面板走明文 HTTP，包括登录密码在内的所有流量都不加密，因此只有在局域网或 VPN 内才是安全的。要从公网访问，请自行在网关前面加一层 HTTPS 反代，例如 Caddy 或 Nginx。

有公网 IP 的机器，`BIND_ADDR` 要填 VPN 地址，不要填 `0.0.0.0`。

初始化向导只在还没有管理员时出现。请在内网完成首次初始化，或用 `AUTH_PASSWORD` 预设管理员，避免入口暴露期间被人抢注。

## 开发

```bash
docker compose up -d --build
docker compose logs -f gateway
```

网关是 Node 22，没有构建步骤。`docker/` 是桌面镜像，Chromium 版本钉死在 Dockerfile 里——升级时改那里，不要在运行时覆盖。[Deploy.md](Deploy.md) 覆盖部署、回滚、健康检查和日志位置。

## License

MIT，见 [LICENSE](LICENSE)。基于 [KasmVNC](https://kasmweb.com/kasmvnc) 与 [LinuxServer.io](https://www.linuxserver.io/) 基础镜像构建。与 OpenAI 无从属关系；ChatGPT 是 OpenAI 的商标。
