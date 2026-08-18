#!/usr/bin/env python3
"""Forward 9223 -> 127.0.0.1:9222. Only the gateway may connect; not published to the host."""
import os
import re
import socket
import threading

LISTEN = ("0.0.0.0", 9223)
TARGET = ("127.0.0.1", 9222)
HOST_RE = re.compile(br"(?i)host:\s*[^\r\n]+")
ALLOWED_NAMES = ("gateway", "gpt-pro-cloud-gateway")


def peer_ip(addr):
    ip = addr[0] if addr else ""
    if ip.startswith("::ffff:"):
        return ip[7:]
    return ip


def allowed(peer):
    names = list(ALLOWED_NAMES)
    extra = os.environ.get("GPC_CDP_ALLOW", "")
    if extra:
        names.extend(x.strip() for x in extra.split(",") if x.strip())
    ips = set()
    for name in names:
        try:
            for item in socket.getaddrinfo(name, None):
                ips.add(item[4][0])
        except OSError:
            continue
    return peer in ips


def rewrite_host(data: bytes) -> bytes:
    if not (data.startswith(b"GET ") or data.startswith(b"POST ") or data.startswith(b"HEAD ")):
        return data
    return HOST_RE.sub(b"Host: 127.0.0.1:9222", data, count=1)


def pipe(src, dst, first=None):
    try:
        if first:
            dst.sendall(first)
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.close()
            except OSError:
                pass


def handle(client):
    try:
        remote = socket.create_connection(TARGET, timeout=5)
    except OSError:
        client.close()
        return
    try:
        first = rewrite_host(client.recv(65536))
    except OSError:
        client.close()
        remote.close()
        return
    threading.Thread(target=pipe, args=(client, remote, first), daemon=True).start()
    pipe(remote, client)


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(16)
    while True:
        client, addr = srv.accept()
        if not allowed(peer_ip(addr)):
            try:
                client.close()
            except OSError:
                pass
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
