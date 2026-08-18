<div align="center">

<img src="assets/hero.svg" alt="GPT-Pro Cloud — your signed-in ChatGPT Pro, served from your own machine" width="100%">

# GPT-Pro Cloud — One Pro seat, every device on the team.

[![Docker](https://img.shields.io/badge/docker-compose-2496ED?style=flat-square&logo=docker&logoColor=white)](docker-compose.yml)
[![Node.js](https://img.shields.io/badge/node.js-22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](gateway/)
[![Chromium](https://img.shields.io/badge/chromium-kiosk-4587F3?style=flat-square&logo=googlechrome&logoColor=white)](docker/)
[![KasmVNC](https://img.shields.io/badge/kasmvnc-web_desktop-5257CF?style=flat-square)](https://kasmweb.com/kasmvnc)
[![Self-hosted](https://img.shields.io/badge/self--hosted-yes-178F5F?style=flat-square)](Deploy.md)
[![License](https://img.shields.io/badge/license-MIT-1a1a18?style=flat-square)](LICENSE)

**English** | [简体中文](README.zh-CN.md)

</div>

---

GPT-Pro Cloud is a Docker gateway and browser desktop for running signed-in ChatGPT sessions on a machine you control. It is for individuals and small teams that need one Pro seat reachable from every device, with no client to install and no second login.

> **Disclaimer** — sharing a ChatGPT account between people may violate OpenAI's terms and policies. This repository only provides a self-hosting mechanism; whether and how you use it, and all consequences, are your own responsibility and unrelated to this repository.

<img src="assets/screenshot-home.jpg" alt="The account picker showing two machine cards with live presence, an admin badge, and the team management entry" width="100%">

Each account gets its own Chromium with a persistent profile. One gateway serves the login, the account picker, team management and the remote desktop — entirely in the browser.

## Install

Runs on Docker Compose (a Linux server; Docker Desktop on macOS or Windows), roughly 1 GB of RAM per account.

```bash
git clone https://github.com/JingxuanKang/GPT-Pro-Cloud.git
cd gpt-pro-cloud
cp .env.example .env
./scripts/up.sh
```

Deploy inside a LAN or a VPN such as Tailscale. The panel speaks plain HTTP — see [Security](#security).

## Quick start

Open `http://<host>:36090` — the first visit walks you through creating the administrator account (or pre-seed it with `AUTH_PASSWORD` in `.env` for automated deployments). Then open each account card once and log in to ChatGPT inside it; the profile survives restarts, so this is a one-time step per account.

After that, any device on the same network opens the same URL and lands in the signed-in session.

## Add an account

One ChatGPT account is one desktop container.

1. Copy a `desktop-*` service in `docker-compose.yml`, with volume `./data/<id>:/config`.
2. Append the id to `INSTANCES` in `.env`.
3. Run `docker compose up -d --build`, open the new card, and log in once.

## Team access

Members are managed on the **Team** page, which only the administrator sees.

| Goal | How |
| --- | --- |
| Add a member | Invite them, then assign which accounts they may open |
| Rotate a credential | Reset that member's password; their sessions are revoked |
| Remove access | Disable or delete the member; live sessions drop immediately |
| See who is using what | Machine cards show live presence per account |

Passwords are stored as per-user salted scrypt hashes. Sign-in is rate limited per `ip|username` (10 attempts per 15 minutes), and sessions survive a restart.

## Clipboard

The clipboard is two-way and uses the shortcuts you already know — copy on your laptop, paste into the remote Chromium, and back. Text and screenshots both work.

## Sharing and memory isolation

There are two ways to share a chat. The basic path needs no automation: click ChatGPT's own Share inside the page and copy — the link reaches your local clipboard through the clipboard relay. With **page assist** on, the top bar gains a Share button that the gateway clicks for you, handing you the link directly.

Memory isolation is what makes one account usable by several people without shared context: with page assist on, the first time a member enters an account, the gateway creates (or reopens) a ChatGPT project named after them, set to **project-only memory**. Chats inside it neither read nor write the account's global memory, members don't leak context to each other, and each member's chats stay grouped in their own project.

Page assist is off by default. It drives chatgpt.com through DevTools selectors, so it can break when OpenAI redesigns the page; with it off you click Share yourself — links still reach your clipboard — and no project onboarding happens.

## Configuration

Everything lives in `.env` — the commented [`.env.example`](.env.example) is the reference.

| Setting | Purpose |
| --- | --- |
| `AUTH_PASSWORD` | Optional: pre-seed the administrator password; leave empty to use the first-visit wizard |
| `INSTANCES` | Comma-separated desktop ids to show as cards |
| `BIND_ADDR` | Address the gateway publishes on; use the VPN address on public hosts |
| `PROXY_URL_A`, `PROXY_URL_B` | Default per-account proxy; edits on the Settings page take precedence and apply immediately |
| `PROXY_URL` | Default proxy shared by every account |

## Architecture

```
browser ──▶ gateway (:36090) ──▶ desktop-a / desktop-b
            login · picker · team    Chromium --kiosk chatgpt.com
```

The gateway is the only published port. VNC and Chromium DevTools stay on the container network and are unreachable from outside. State lives in `./data/` (Chromium profiles) and `./data-panel/` (members, sessions, settings); both are git-ignored and never leave the host.

## Security

The panel speaks plain HTTP. Everything, including the sign-in password, travels unencrypted, so this is safe only inside a LAN or a VPN. For access from the open internet, put an HTTPS reverse proxy such as Caddy or Nginx in front of the gateway.

On a host with a public IP, set `BIND_ADDR` to the VPN address rather than `0.0.0.0`.

The setup wizard only appears while no administrator exists. Complete the first run inside your private network, or pre-seed the administrator with `AUTH_PASSWORD`, so an exposed entry cannot be claimed by a stranger.

## Development

```bash
docker compose up -d --build
docker compose logs -f gateway
```

The gateway is Node 22 with no build step. `docker/` holds the desktop image with a pinned Chromium version — bump it there, not at runtime. [Deploy.md](Deploy.md) covers rollout, rollback, health checks and log locations.

## License

MIT. See [LICENSE](LICENSE). Built on [KasmVNC](https://kasmweb.com/kasmvnc) and the [LinuxServer.io](https://www.linuxserver.io/) base image. Not affiliated with OpenAI; ChatGPT is a trademark of OpenAI.
