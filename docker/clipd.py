#!/usr/bin/env python3
"""Accept a paste from the gateway and put it on the X clipboard, then Ctrl+V."""
from __future__ import annotations

import base64
import hashlib
import os
import re
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
        subprocess.run(["pkill", "-f", pat], check=False, timeout=5)


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


SHARE_RE = re.compile(
    r"https://(?:(?:chatgpt\.com|chat\.openai\.com)/(?:share|s)/[A-Za-z0-9_-]+(?:[/?#][^\s\"'<>]*)?|(?:files\.)?oaiusercontent\.com/[^\s\"'<>]+)",
    re.I,
)


def extract_share_url(text: str) -> str:
    match = SHARE_RE.search(text or "")
    if not match:
        return ""
    return match.group(0).rstrip(").,;")


def clip_blank(mime: str, data: bytes) -> bool:
    if not data:
        return True
    if mime.startswith("text/") and not data.strip():
        return True
    return False


def prefer_clip(before: tuple[str, bytes, str], after: tuple[str, bytes, str]) -> tuple[str, bytes, str]:
    """Keep a previous image when Ctrl+C lands on an empty selection."""
    if clip_blank(after[0], after[1]) and not clip_blank(before[0], before[1]):
        return before
    return after


def clip_etag(data: bytes, share: str) -> str:
    digest = hashlib.sha256(data + b"\0" + share.encode("utf-8", "replace")).hexdigest()[:16]
    return f'"xclip-{digest}"'


def _xclip(args: list[str], timeout: float = 3) -> bytes:
    return subprocess.run(
        ["xclip", "-selection", "clipboard", *args],
        capture_output=True,
        env=env(),
        timeout=timeout,
        check=False,
    ).stdout


def html_data_image(raw: bytes) -> tuple[str, bytes] | None:
    text = raw.decode("utf-8", "replace")
    match = re.search(r"data:image/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)", text, re.I)
    if not match:
        return None
    kind = match.group(1).lower()
    mime = "image/jpeg" if kind in ("jpeg", "jpg") else f"image/{kind}"
    try:
        data = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=False)
    except Exception:
        return None
    if not data or len(data) > MAX:
        return None
    return mime, data


def clip_out() -> tuple[str, bytes, str]:
    targets = _xclip(["-t", "TARGETS", "-o"]).decode("utf-8", "replace")
    image = b""
    mime = ""
    for candidate in ("image/png", "image/jpeg", "image/webp"):
        if candidate in targets:
            blob = _xclip(["-t", candidate, "-o"], timeout=5)
            if blob:
                image = blob
                mime = candidate
                break
    text = _xclip(["-o"])
    share = extract_share_url(text.decode("utf-8", "replace"))
    if "text/html" in targets and (not share or not image):
        html = _xclip(["-t", "text/html", "-o"], timeout=5)
        if not share:
            share = extract_share_url(html.decode("utf-8", "replace"))
        if not image:
            found = html_data_image(html)
            if found:
                mime, image = found
    if image:
        return mime, image, share
    return "text/plain; charset=utf-8", text, share


def grab() -> tuple[str, bytes, str]:
    before = clip_out()
    e = env()
    subprocess.run(
        ["xdotool", "key", "--clearmodifiers", "ctrl+c"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=e,
        check=False,
        timeout=5,
    )
    time.sleep(0.2)
    return prefer_clip(before, clip_out())


def _respond(handler: BaseHTTPRequestHandler, mime: str, data: bytes, share: str) -> None:
    etag = clip_etag(data, share)
    inm = handler.headers.get("If-None-Match")
    if inm and inm == etag:
        handler.send_response(204)
        handler.send_header("ETag", etag)
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()
        return
    safe = share if share and share.isascii() and "\n" not in share and "\r" not in share else ""
    handler.send_response(200)
    handler.send_header("Content-Type", mime)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("ETag", etag)
    handler.send_header("Cache-Control", "no-store")
    if safe:
        handler.send_header("X-Gpc-Share", safe)
    handler.end_headers()
    handler.wfile.write(data)


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
        mime, data, share = clip_out()
        _respond(self, mime, data, share)

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
            mime, data, share = grab()
            print(f"gpc-clipd grab mime={mime} bytes={len(data)}", flush=True)
            _respond(self, mime, data, share)
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
