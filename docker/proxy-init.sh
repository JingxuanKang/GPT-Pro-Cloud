#!/usr/bin/with-contenv bash
# 把宿主代理写成容器内 Chromium 能用的地址。
# 127.0.0.1 / localhost 在容器里指向自己，必须改成 host.docker.internal。
set -e

# 按账号 override（compose 里的 PROXY_URL_OVERRIDE）优先于全局 PROXY_URL
RAW="${PROXY_URL_OVERRIDE:-${PROXY_URL:-}}"
RAW="${RAW//127.0.0.1/host.docker.internal}"
RAW="${RAW//localhost/host.docker.internal}"
# [::1] 必须转义：bash 的 ${var//pat/} 是通配匹配，不转义会变成字符类（匹配 : 和 1）
RAW="${RAW//\[::1\]/host.docker.internal}"

OUT=/config/.gpc-proxy
{
    echo "PROXY_URL='${RAW}'"
    echo "START_URL='${START_URL:-https://chatgpt.com}'"
} > "$OUT"
chown "${PUID:-1000}:${PGID:-1000}" "$OUT" 2>/dev/null || true

if [ -n "$RAW" ]; then
    echo "[gpc-proxy] Chromium 出口 = ${RAW}"
else
    echo "[gpc-proxy] 未设置代理，走宿主默认出口"
fi
