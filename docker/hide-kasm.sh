#!/usr/bin/with-contenv bash
# 藏 Kasm 启动页和品牌。不要藏控制栏 / Connect 按钮，否则 autoconnect 会黑屏。
set -e
CSS='/* gpc-hide */
html, body, #noVNC_container {
  background: #fff !important;
  background-image: none !important;
}
#noVNC_transition,
#noVNC_transition_text,
.noVNC_spinner,
.noVNC_logo,
.noVNC_logo a,
a[href*="kasmweb.com"] {
  display: none !important;
}
#noVNC_keyboardinput {
  width: 2px !important;
  height: 2px !important;
  opacity: 0.01 !important;
  overflow: hidden !important;
}'

inject() {
  root=$1
  [ -d "$root" ] || return 0
  printf '%s\n' "$CSS" > "$root/gpc-hide.css"
  for html in "$root/index.html" "$root/vnc.html"; do
    [ -f "$html" ] || continue
    if ! grep -q 'gpc-hide.css' "$html"; then
      if grep -q '<title>KasmVNC</title>' "$html"; then
        sed -i 's|<title>KasmVNC</title>|<title>ChatGPT</title><link rel="stylesheet" href="gpc-hide.css">|' "$html"
      elif grep -q '<title>GPT Pro</title>' "$html"; then
        sed -i 's|<title>GPT Pro</title>|<title>ChatGPT</title><link rel="stylesheet" href="gpc-hide.css">|' "$html"
      else
        sed -i 's|</title>|</title><link rel="stylesheet" href="gpc-hide.css">|' "$html"
      fi
    else
      sed -i 's|<title>KasmVNC</title>|<title>ChatGPT</title>|; s|<title>GPT Pro</title>|<title>ChatGPT</title>|' "$html"
    fi
  done
}

inject /usr/share/kasmvnc/www
inject /usr/local/share/kasmvnc/www
echo "[gpc-hide] splash hidden"
