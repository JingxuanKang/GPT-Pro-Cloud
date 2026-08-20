#!/usr/bin/env python3
"""Forward 9223 -> 127.0.0.1:9222. Only the gateway may connect; not published to the host."""
import os
import re
import select
import socket
import threading

LISTEN = ("0.0.0.0", 9223)
TARGET = ("127.0.0.1", 9222)
HOST_RE = re.compile(br"(?i)host:\s*[^\r\n]+")
CONN_RE = re.compile(br"(?i)connection:\s*[^\r\n]+")
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


def is_ws_upgrade(data: bytes) -> bool:
    return b"upgrade: websocket" in data.lower()


def rewrite_host(data: bytes) -> bytes:
    if not (data.startswith(b"GET ") or data.startswith(b"PUT ") or data.startswith(b"POST ") or data.startswith(b"HEAD ")):
        return data
    return HOST_RE.sub(b"Host: 127.0.0.1:9222", data, count=1)


def force_connection_close(data: bytes) -> bytes:
    """Stop HTTP keep-alive. Leftover ESTAB sockets to :9222 make /json/version 500."""
    if not (data.startswith(b"GET ") or data.startswith(b"PUT ") or data.startswith(b"POST ") or data.startswith(b"HEAD ")):
        return data
    if CONN_RE.search(data):
        return CONN_RE.sub(b"Connection: close", data, count=1)
    if b"\r\n\r\n" in data:
        return data.replace(b"\r\n\r\n", b"\r\nConnection: close\r\n\r\n", 1)
    if b"\n\n" in data:
        return data.replace(b"\n\n", b"\nConnection: close\n\n", 1)
    return data


def close_pair(*socks):
    for s in socks:
        try:
            s.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            s.close()
        except OSError:
            pass


def pump(a, b, idle=None):
    """Copy until either side EOFs, then close both. idle=None waits forever (WebSocket)."""
    pair = {a: b, b: a}
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [], idle)
            if not ready:
                break
            for src in ready:
                try:
                    chunk = src.recv(65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    return
                try:
                    pair[src].sendall(chunk)
                except OSError:
                    return
    finally:
        close_pair(a, b)


def handle(client):
    try:
        remote = socket.create_connection(TARGET, timeout=5)
    except OSError:
        close_pair(client)
        return
    try:
        first = client.recv(65536)
    except OSError:
        close_pair(client, remote)
        return
    if not first:
        # Empty client → do not leave an unused ESTAB to :9222 (phoenix leak).
        close_pair(client, remote)
        return
    first = rewrite_host(first)
    ws = is_ws_upgrade(first)
    if not ws:
        first = force_connection_close(first)
    try:
        remote.sendall(first)
    except OSError:
        close_pair(client, remote)
        return
    pump(client, remote, idle=None if ws else 15)


def main():
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(16)
    while True:
        client, addr = srv.accept()
        if not allowed(peer_ip(addr)):
            close_pair(client)
            continue
        threading.Thread(target=handle, args=(client,), daemon=True).start()


if __name__ == "__main__":
    main()
