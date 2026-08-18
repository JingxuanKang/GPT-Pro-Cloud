#!/usr/bin/with-contenv bash
# 每个数据卷一个持久 machine-id，避免所有实例共用镜像里烤死的同一个指纹。
set -e

ID_FILE=/config/.gpc-machine-id

if [ ! -s "$ID_FILE" ]; then
    if [ -r /proc/sys/kernel/random/uuid ]; then
        tr -d '-' < /proc/sys/kernel/random/uuid | tr 'A-F' 'a-f' > "$ID_FILE"
    else
        head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$ID_FILE"
    fi
fi

MID="$(tr -dc 'a-f0-9' < "$ID_FILE" | head -c 32)"
if [ "${#MID}" -ne 32 ]; then
    MID="$(tr -d '-' < /proc/sys/kernel/random/uuid | tr 'A-F' 'a-f' | head -c 32)"
    printf '%s\n' "$MID" > "$ID_FILE"
fi

printf '%s\n' "$MID" > /etc/machine-id 2>/dev/null || true
mkdir -p /var/lib/dbus
printf '%s\n' "$MID" > /var/lib/dbus/machine-id 2>/dev/null || true
rm -f /.dockerenv 2>/dev/null || true

echo "[gpc-identity] machine-id 已写入数据卷"
