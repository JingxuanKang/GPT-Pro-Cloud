# Deploy.md — GPT-Pro Cloud

## 组成

| 容器 | 说明 |
|---|---|
| `gpt-pro-cloud-gateway` | 唯一入口 `:36090`，登录、账号选择、团队管理、桌面反代 |
| `gpt-pro-cloud-a` / `b` | 每个 ChatGPT 账号一只独立 Chromium；DevTools `9222/9223` 不映射宿主机，CDP 转发只接受 gateway |

持久化数据都在仓库目录下：`./data/{a,b}`（Chromium profile 与 ChatGPT 登录态）、`./data-panel/`（成员 `users.json`、会话 `sessions.json` 与设置）。两者都被 gitignore。

## 启动

```bash
cp .env.example .env
# 必填 AUTH_PASSWORD；有公网 IP 的机器把 BIND_ADDR 设为内网 IP（如 Tailscale IP），不要 0.0.0.0
./scripts/up.sh
```

## 健康检查

```bash
curl -fsS http://127.0.0.1:36090/healthz
```

## 日志

```bash
docker compose logs -f gateway
docker compose logs -f desktop-a
```

## 更新与回滚

更新：开发机 commit → push → 部署机 `git pull && docker compose up -d --build`。

回滚：部署机 `git checkout <旧 commit> && docker compose up -d --build`。`data/` 与 `data-panel/` 不随代码回滚，登录态与成员配置保持不变。
