<div align="center">

<img src="assets/hero.svg" alt="GPT-Pro Cloud — your signed-in ChatGPT Pro, served from your own machine" width="100%">

# GPT-Pro Cloud — One Pro seat, every device on the team.

[![Docker](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](gateway/)
[![Chromium](https://img.shields.io/badge/chromium-tab_seats-4587F3?style=flat-square&logo=googlechrome&logoColor=white)](docker/)
[![KasmVNC](https://img.shields.io/badge/kasmvnc-web_desktop-5257CF?style=flat-square)](https://kasmweb.com/kasmvnc)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-178F5F?style=flat-square)](Deploy.md)
[![License](https://img.shields.io/badge/license-MIT-1a1a18?style=flat-square)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

</div>

---

GPT-Pro Cloud is a Docker gateway and browser desktop for running signed-in ChatGPT sessions on a machine you control. It is for individuals and small teams that need one Pro seat reachable from every device, with no client to install and no second login.

> **Disclaimer** — sharing a ChatGPT account between people may violate OpenAI's terms and policies. This repository only provides a self-hosting mechanism; whether and how you use it, and all consequences, are your own responsibility and unrelated to this repository.

<img src="assets/screenshot-home.jpg" alt="The account picker showing account cards with live presence, tab-seat usage and the admin entry" width="100%">

Each account gets its own Chromium with a persistent profile. One gateway serves the login, the account picker, team management and the remote desktop — entirely in the browser.

Sharing one ChatGPT account with more than one person at a time is **opt-in** (Chromium DevTools / CDP) and **off by default**. Exclusive VNC for a single occupant does not open the debug port.

## Install

Runs on Docker Compose (a Linux server; Docker Desktop on macOS or Windows), roughly 1 GB of RAM per account.

This repository is public. `./scripts/up.sh` **pulls** the published GHCR images (`ghcr.io/jingxuankang/gpt-pro-cloud-gateway:latest` and `ghcr.io/jingxuankang/gpt-pro-cloud-desktop:latest`) and starts the stack — it does not `--build` on your machine.

```bash
git clone https://github.com/JingxuanKang/GPT-Pro-Cloud.git
cd GPT-Pro-Cloud
cp .env.example .env
./scripts/up.sh
```

Or fetch compose only and pull the same public images:

```bash
mkdir gpt-pro-cloud && cd gpt-pro-cloud
curl -fsSLO https://raw.githubusercontent.com/JingxuanKang/GPT-Pro-Cloud/main/docker-compose.yml
curl -fsSLo .env.example https://raw.githubusercontent.com/JingxuanKang/GPT-Pro-Cloud/main/.env.example
cp .env.example .env
docker compose pull && docker compose up -d
```

If pull fails (images not published yet), build locally with `docker compose up -d --build`, or wait for the publish workflow on `main`.

Private access: a LAN or a VPN such as Tailscale (plain HTTP). Public access: a Cloudflare Tunnel after the administrator exists — [Public access](#public-access).

## Quick start

Open `http://127.0.0.1:36090` (or the LAN / VPN host) — the first visit walks you through creating the administrator account (or pre-seed it with `AUTH_PASSWORD` in `.env` for automated deployments). Then open each account card once and log in to ChatGPT inside the desk; that ChatGPT login is a one-time step you do yourself — it is not automated. The profile survives restarts.

After that, any device on the same private network opens the same URL and lands in the signed-in session. Finish the administrator on localhost or the LAN before starting a public tunnel — otherwise a stranger who opens the public URL could claim admin.

## Public access

HTTPS on the open internet is a Cloudflare Tunnel. The administrator must already exist (wizard or `AUTH_PASSWORD`) before the tunnel goes up. Opening the public URL must be the login page, not the first-visit wizard.

Set `BIND_ADDR=127.0.0.1` in `.env` so the panel is not also published as plain HTTP on a public NIC, then:

```bash
# quick tunnel: no domain required
cloudflared tunnel --url http://127.0.0.1:36090
```

Share the `https://` URL it prints. You sign in with the administrator you already created. Members use the gateway username and password from the Admin page — not ChatGPT passwords.

For a stable hostname, point a named tunnel at the same local port (that needs a domain on Cloudflare).

## Add an account

One ChatGPT account is one desktop container. The administrator adds one from the home page: **Add ChatGPT account**, give it a name, and a new card appears. Open it and log in to ChatGPT once — same as `a` / `b`.

The gateway clones the `desktop-a` image onto the compose network via the Docker Engine API (`desktop-<id>` DNS, volume `./data/<id>:/config`). Extra desks are stored in `data-panel/users.json` and their containers use `restart: unless-stopped`, so they survive a gateway restart without editing `INSTANCES` or `docker-compose.yml`.

One-time host setup: `docker-compose.yml` mounts `/var/run/docker.sock` into the gateway. After pulling this change, run `docker compose up -d` once so the mount is applied. Then adding a desk is a panel action — do not SSH in to copy compose services as the happy path.

`INSTANCES` and the `desktop-a` / `desktop-b` services stay as the built-in seats. Do not remove them; new desks are cloned from `desktop-a`.

A Cloud / CI VM that does not run the desktop image cannot prove a live Chromium. On a real Docker host (phoenix) verify: add a desk in the UI, `docker ps` shows `gpt-pro-cloud-<id>`, open the card, and complete the ChatGPT login.

## Team access

Members are managed on the **Team** page, which only the administrator sees.

| Goal | How |
| --- | --- |
| Add a member | Invite them, then assign which accounts they may open |
| Rotate a credential | Reset that member's password; their sessions are revoked |
| Remove access | Disable or delete the member; live sessions drop immediately |
| See who is using what | Machine cards show live presence per account; Team lists occupancy as information |
| Disconnect a live seat | On a live account card, **断开** revokes that member's login and drops **their** VNC or tab seat; other members on the same account keep their tab. The container stays up. They sign in again. The member stays |
| Delete an extra account | On a panel-created card, **删除** stops the container and wipes `./data/<id>` so a re-add is clean. Built-in `a` / `b` stay |

Passwords are stored as per-user salted scrypt hashes. Sign-in is rate limited per `ip|username` (10 attempts per 15 minutes), and sessions survive a restart.

## Clipboard

The clipboard is two-way between your machine and the desk on the exclusive VNC path. Text and screenshots both work there (gpc-clipd / xclip). That path does not need the debug port.

Tab seats exist only when multi-user / CDP is on for that account. They cannot use the X11 clip relay — it is one clipboard for the whole desktop, not one per tab. They paste text via CDP `Input.insertText` and images (png/jpeg/webp) via a synthetic `ClipboardEvent` on `document.activeElement`. Click the composer first; if nothing is focused the UI says to click the input. They never write the shared X11 clipboard.

## Sharing and memory isolation

There are two ways to share a chat. The basic path needs no automation: click ChatGPT's own Share inside the page and copy — the link reaches your local clipboard through the clipboard relay. With **page assist** on, the top bar gains a Share button that the gateway clicks for you, handing you the link directly.

Memory isolation is what makes one account usable by several people without shared context. Turning **多人分屏** on is a job: every assigned member gets a same-username ChatGPT project with **project-only memory** (created in a parked tab, not shown to members). Assigning a member while the desk is already on creates that project immediately. Members never create a project when they open a desk — they land on the stored `https://chatgpt.com/g/g-p-<id>-<slug>/project` URL. Chats inside a project neither read nor write the account's global memory, members don't leak context to each other, and each member's chats stay grouped in their own project. The administrator does not get a ChatGPT project; they use the complete uncut desktop.

When multi-user / CDP is **on**, the page keeps each member in their own project: other project links are hidden in the sidebar, and a click or navigation to another `/g/g-p-…` path is sent back to that member's project. The occupant cannot open another Chrome tab, window, split, or address bar (Ctrl/Cmd+T/N/L/W/Tab, Shift+T, Alt+D, F6, F12, Ctrl+Shift+I/J/C, Ctrl+U, and page `window.open`). Gateway tab seats stay — one isolated ChatGPT target per member. Copy/paste (Ctrl/Cmd+C/V) still works. This is an in-page lock (CDP inject + `Page.navigate`), not a server ACL — the same ChatGPT cookies are still shared. The conversation list may still show other people's titles.

When CDP is **off**, there is no per-member jail (one VNC desktop). If the administrator pastes a single project URL as the desk start URL, the kiosk can open there, but that is one project for whoever uses the desk.

Page assist is not a separate switch: it is part of the per-account **multi-user / debug port** toggle (off by default). It drives chatgpt.com through DevTools selectors, so it can break when OpenAI redesigns the page; with the toggle off you click Share yourself — links still reach your clipboard — and no project onboarding or per-member jail happens.

## Configuration

Everything lives in `.env` — the commented [`.env.example`](.env.example) is the reference.

| Setting | Purpose |
| --- | --- |
| `AUTH_PASSWORD` | Optional: pre-seed the administrator password; leave empty to use the first-visit wizard |
| `INSTANCES` | Built-in compose seats (`a,b`). Extra desks are added in the panel |
| `TAB_SEATS_MAX` | Concurrent chatgpt.com tab seats per account when multi-user is on (default `3`, range 1–8). Members get tab seats; the admin uses the full desktop. Idle tabs close after ~45s without a presence beat |
| `BIND_ADDR` | Address the gateway publishes on; `127.0.0.1` when tunneling, LAN or VPN address on a private network |
| `PROXY_URL_A`, `PROXY_URL_B` | Default per-account proxy; Settings (per desk or Apply to all) take precedence and apply immediately |
| `PROXY_URL` | Default proxy shared by every account |

A proxy is only needed when the server cannot reach ChatGPT directly (for example, hosts in mainland China); leave it empty otherwise. The prerequisite is an `http://` / `https://` / `socks5://` endpoint reachable from the server — for a proxy client running on the host, a loopback address like `http://127.0.0.1:7890` works and is rewritten to a container-reachable one automatically.

On **Settings**, **Apply to all** writes the same address to every ChatGPT desk and pushes it live the same way as saving one row (clipd / `--proxy-server`, Chromium restarts). Addresses you have saved stay as chips so you can pick one again without retyping.

## Concurrent tab seats

One ChatGPT account is still one desktop container and one Chromium profile (`--user-data-dir=/config/chromium`). Two members must not share one VNC mouse — and on a multi-user desk they must not share one desktop picture either. Multi-user tab seats require the admin to turn on **允许多人同时使用** for that account; until then a second person is refused.

- When multi-user (CDP) is **off**, the first occupant gets exclusive KasmVNC. A second person is refused (`409 CDP_OFF`).
- When multi-user is **on**, members get their own `chatgpt.com` tab seats in the same Chromium, jailed to their project. The admin gets the complete uncut desktop (VNC) and can see other people's Chrome tabs. Members never receive the full desktop. Later members get a new window (`newWindow: true`), parked off-screen — never a tab on the last/primary window. The gateway streams **that window only** (CDP `Page.startScreencast`) and injects pointer/keyboard with CDP `Input`. The member never sees the tab strip or another seat's target.
- **断开** on the account card is per-seat: it drops that member's tab (or VNC) without killing the other tab or the container.
- Cap: `TAB_SEATS_MAX` (default 3 tab seats; everyone is a tab when multi-user is on). An idle tab seat is closed after about 45 seconds without a presence beat.
- ChatGPT's own sidebar may still list the other member's chats. Other *projects* are hidden first; a navigation to another `/g/g-p-…/project` is bounced back. If the stored project URL is missing, the member is refused (`工作区未就绪`) — the admin re-runs the enable job or unchecks and rechecks the user. Share and page assist run only while that desk's split-screen is on.
- `--kiosk` is off. With split-screen on, Chromium is a normal window (not `--app`) so extra seat windows stay in-process. Extra targets are new windows parked off-screen; members see the page viewport, not browser chrome.

A Cloud / CI VM cannot run the real desktop image. Unit tests cover seat assignment, target isolation, disconnect-one-tab, and the occupancy cap. Phoenix should confirm two members on one signed-in account each see only their tab.

## Architecture

```
browser ──▶ gateway (:36090) ──▶ desktop-a / desktop-b / extra desks
            login · picker · admin    one Chromium profile per account
                                     ├─ CDP off: exclusive KasmVNC (second occupant 409)
                                     └─ CDP on: members get tab seats; admin gets the complete desktop
```

The gateway is the only published port. VNC and Chromium DevTools stay on the container network and are unreachable from outside. State lives in `./data/` (Chromium profiles) and `./data-panel/` (members, sessions, settings); both are git-ignored and never leave the host.

## Security

The panel speaks plain HTTP. Everything, including the sign-in password, travels unencrypted, so direct access is only for a LAN or a VPN. Public access is HTTPS via Cloudflare Tunnel — see [Public access](#public-access). When tunneling, set `BIND_ADDR=127.0.0.1`; on a private network on a public-IP host, bind the LAN or VPN address — never `0.0.0.0` on a public NIC.

The setup wizard only appears while no administrator exists. Finish it on localhost or the LAN, or pre-seed with `AUTH_PASSWORD`, before starting the tunnel.

Rate limits and audit logs trust `CF-Connecting-IP` for requests that arrive through the tunnel.

## Development

```bash
docker compose up -d --build
docker compose logs -f gateway
```

The gateway is Node 22 with no build step. `docker/` holds the desktop image with a pinned Chromium version — bump it there, not at runtime. [Deploy.md](Deploy.md) covers rollout, rollback, health checks and log locations.

## License

MIT. See [LICENSE](LICENSE). Built on [KasmVNC](https://kasmweb.com/kasmvnc) and the [LinuxServer.io](https://www.linuxserver.io/) base image. Not affiliated with OpenAI; ChatGPT is a trademark of OpenAI.

## Links

[![认可linux.do](https://ld.xh.do/ld-badge.svg)](https://linux.do)
