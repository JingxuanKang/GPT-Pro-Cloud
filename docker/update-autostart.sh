#!/usr/bin/with-contenv bash
# baseimage 只在 autostart 缺失时拷贝。升级镜像后必须覆盖数据卷里的旧副本。
mkdir -p /config/.config/openbox /config/Desktop /config/chromium
cp /defaults/autostart /config/.config/openbox/autostart
chmod +x /config/.config/openbox/autostart

# 去掉 Openbox 标题栏（最大化 / 关闭）。用户不能关窗或缩放。
python3 - <<'PY'
from pathlib import Path
import re

src = Path("/etc/xdg/openbox/rc.xml")
dst = Path("/config/.config/openbox/rc.xml")
if not src.is_file():
    raise SystemExit(0)
text = src.read_text(encoding="utf-8")
text = re.sub(r"<titleLayout>[^<]*</titleLayout>", "<titleLayout></titleLayout>", text, count=1)
text = text.replace("<keepBorder>yes</keepBorder>", "<keepBorder>no</keepBorder>", 1)
text = re.sub(
    r'(<keybind key="A-F4">\s*)<action name="Close"/>',
    r"\1<action name='Unfocus'/>",
    text,
    count=1,
)
if "gpc-no-chrome" not in text:
    text = text.replace(
        "</applications>",
        """  <!-- gpc-no-chrome -->
  <application class="*">
    <decor>no</decor>
    <maximized>yes</maximized>
    <fullscreen>yes</fullscreen>
  </application>
</applications>""",
        1,
    )
# VNC-only best-effort: swallow Chrome escape chords. Tab seats go through CDP Input instead.
if "gpc-jail-keys" not in text:
    keys = (
        "C-T",
        "C-S-T",
        "C-N",
        "C-S-N",
        "C-W",
        "C-S-W",
        "C-L",
        "C-Tab",
        "C-S-Tab",
        "A-D",
        "F6",
        "F12",
        "C-S-I",
        "C-S-J",
        "C-S-C",
        "C-U",
    )
    for key in keys:
        text = re.sub(
            rf'<keybind\s+key="{re.escape(key)}">.*?</keybind>',
            "",
            text,
            flags=re.DOTALL,
        )
    lock = "\n".join(f'  <keybind key="{key}"><action name="Unfocus"/></keybind>' for key in keys)
    text = text.replace("</keyboard>", f"  <!-- gpc-jail-keys -->\n{lock}\n</keyboard>", 1)
dst.write_text(text, encoding="utf-8")
PY

chown "${PUID:-1000}:${PGID:-1000}" \
    /config/.config/openbox/autostart \
    /config/.config/openbox/rc.xml \
    /config/Desktop \
    /config/chromium 2>/dev/null || true
