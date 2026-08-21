#!/usr/bin/env python3
"""Accept a paste from the gateway and put it on the X clipboard, then Ctrl+V."""
from __future__ import annotations

import os
import subprocess
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 18790
MAX = 8 * 1024 * 1024

# /usr/bin/chromium is a wrapper; the live process on Debian/Ubuntu is
# /usr/lib/chromium/chromium. Matching only the wrapper leaves the old PID up
# (phoenix: CDP toggle wrote .gpc-cdp but Chrome kept the CDP-off process).
CHROMIUM_KILL_PATTERNS = (
    "/usr/lib/chromium/chromium",
    "--user-data-dir=/config/chromium",
)


def kill_chromium() -> None:
    for pat in CHROMIUM_KILL_PATTERNS:
        # Patterns that start with -- must follow pkill's -- or pkill
        # treats them as its own flags (e.g. --user-data-dir=...).
        subprocess.run(["pkill", "-f", "--", pat], check=False, timeout=5)


def display() -> str:
    d = os.environ.get("DISPLAY")
    if d:
        return d
    try:
        xs = sorted(n for n in os.listdir("/tmp/.X11-unix") if n.startswith("X"))
    except FileNotFoundError:
        xs = []
    if xs:
        return ":" + xs[0][1:]
    return ":1"


def env() -> dict[str, str]:
    out = os.environ.copy()
    out["DISPLAY"] = display()
    for p in ("/config/.Xauthority", os.path.expanduser("~/.Xauthority")):
        if os.path.exists(p):
            out["XAUTHORITY"] = p
            break
    return out


def clip_out() -> tuple[str, bytes]:
    e = env()
    targets = subprocess.run(
        ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
        capture_output=True,
        env=e,
        timeout=3,
        check=False,
    ).stdout.decode("utf-8", "replace")
    if "image/png" in targets or "image/jpeg" in targets:
        mime = "image/png" if "image/png" in targets else "image/jpeg"
        img = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", mime, "-o"],
            capture_output=True,
            env=e,
            timeout=5,
            check=False,
        ).stdout
        if img:
            return mime, img
    text = subprocess.run(
        ["xclip", "-selection", "clipboard", "-o"],
        capture_output=True,
        env=e,
        timeout=3,
        check=False,
    ).stdout
    return "text/plain; charset=utf-8", text


def grab() -> tuple[str, bytes]:
    e = env()
    subprocess.run(
        ["xdotool", "key", "--clearmodifiers", "ctrl+c"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=e,
        check=False,
        timeout=5,
    )
    time.sleep(0.12)
    return clip_out()


def clip_in(data: bytes, mime: str) -> None:
    e = env()
    for p in ("/config/.Xauthority", os.path.expanduser("~/.Xauthority")):
        if os.path.exists(p):
            e["XAUTHORITY"] = p
            break
    # Chromium reads UTF8_STRING / default targets, not text/plain.
    if mime.startswith("image/"):
        clip = ["xclip", "-selection", "clipboard", "-t", mime, "-i"]
    else:
        clip = ["xclip", "-selection", "clipboard", "-i"]
    subprocess.run(
        clip,
        input=data,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=e,
        check=False,
        timeout=5,
    )
    subprocess.run(
        ["xdotool", "key", "--clearmodifiers", "ctrl+v"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=e,
        check=False,
        timeout=5,
    )


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        mime, data = clip_out()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        if self.path.rstrip("/") == "/proxy":
            # 面板按账号改代理：写 override 文件（回环改写成 host.docker.internal），
            # 杀掉 Chromium 让 autostart 用新代理重启。空 body = 强制直连。
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = 0
            if n > 512:
                self.send_response(413)
                self.end_headers()
                return
            raw = self.rfile.read(n).decode("utf-8", "replace").strip() if n else ""
            for loop in ("127.0.0.1", "localhost", "[::1]"):
                raw = raw.replace(loop, "host.docker.internal")
            path = "/config/.gpc-proxy-override"
            if raw:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(raw + "\n")
            else:
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass
            print(f"gpc-clipd proxy override={raw or '(default)'}", flush=True)
            kill_chromium()
            self.send_response(204)
            self.end_headers()
            return
        if self.path.rstrip("/") == "/cdp":
            # 面板按账号开关多人分屏：写 /config/.gpc-cdp，杀掉 Chromium，
            # autostart 下一轮按开关带或不带 remote-debugging-* 并启停 cdp-fwd。
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = 0
            if n > 32:
                self.send_response(413)
                self.end_headers()
                return
            raw = self.rfile.read(n).decode("utf-8", "replace").strip().lower() if n else ""
            on = raw in ("1", "true", "on", "yes")
            path = "/config/.gpc-cdp"
            with open(path, "w", encoding="utf-8") as f:
                f.write("1\n" if on else "0\n")
            print(f"gpc-clipd cdp enable={int(on)}", flush=True)
            kill_chromium()
            self.send_response(204)
            self.end_headers()
            return
        if self.path.rstrip("/") == "/grab":
            mime, data = grab()
            print(f"gpc-clipd grab mime={mime} bytes={len(data)}", flush=True)
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX:
            self.send_response(413 if n > MAX else 400)
            self.end_headers()
            return
        body = self.rfile.read(n)
        mime = (self.headers.get("Content-Type") or "text/plain").split(";")[0].strip()
        target = mime if mime.startswith("image/") else "text/plain"
        print(f"gpc-clipd paste mime={target} bytes={len(body)}", flush=True)
        clip_in(body, target)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_args) -> None:
        return


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
