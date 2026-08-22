/**
 * Admin VNC on a CDP-on desk: one primary ChatGPT window in front.
 * Member seat windows stay alive but off the visible desktop.
 */
import { CHATGPT_START, deskBrowsers, listDeskTargets, parkSeatTarget, isChatGPTPage } from "./cdp.mjs";
import { deskContainerName } from "./docker.mjs";

export function isPrimaryChatGPTUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (!/(^|\.)chatgpt\.com$/i.test(parsed.hostname)) return false;
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return path === "/";
  } catch {
    return false;
  }
}

export function isMemberProjectUrl(url) {
  return /chatgpt\.com\/g\/g-p-/i.test(String(url || ""));
}

export function pickPrimaryChatGPTTarget(targets, { claimedTargetIds = [] } = {}) {
  const claimed = new Set((claimedTargetIds || []).filter(Boolean));
  const pages = (targets || [])
    .map((t) => ({ ...t, id: t?.id || t?.targetId }))
    .filter((t) => t.id && (t.type || "page") === "page" && !claimed.has(t.id));
  return (
    pages.find((t) => isPrimaryChatGPTUrl(t.url)) ||
    pages.find((t) => isChatGPTPage(t) && !isMemberProjectUrl(t.url)) ||
    pages.find((t) => isChatGPTPage(t)) ||
    pages[0] ||
    null
  );
}

export function shouldParkForAdmin(target, { claimedTargetIds = [], primaryId } = {}) {
  const id = target?.id || target?.targetId;
  if (!id || id === primaryId) return false;
  if ((claimedTargetIds || []).includes(id)) return true;
  return isMemberProjectUrl(target?.url);
}

export async function raiseTargetWindow(cdp, targetId) {
  const win = await cdp.send("Browser.getWindowForTarget", { targetId });
  if (win?.windowId == null) return false;
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { windowState: "normal" },
    });
  } catch {
    /* still try maximize */
  }
  try {
    await cdp.send("Browser.setWindowBounds", {
      windowId: win.windowId,
      bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "maximized" },
    });
  } catch {
    try {
      await cdp.send("Browser.setWindowBounds", {
        windowId: win.windowId,
        bounds: { windowState: "fullscreen" },
      });
    } catch {
      return false;
    }
  }
  try {
    await cdp.send("Target.activateTarget", { targetId });
  } catch {
    /* focus is best-effort */
  }
  return true;
}

export async function dismissCrashRestore(cdp) {
  const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  try {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...esc });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...esc });
    return true;
  } catch {
    return false;
  }
}

export const RELAX_OPENBOX_SH = `python3 -c "from pathlib import Path
p=Path('/config/.config/openbox/rc.xml')
t=p.read_text() if p.exists() else ''
if t and '<maximized>yes</maximized>' in t:
    t=t.replace('<maximized>yes</maximized>','<maximized>no</maximized>')
    t=t.replace('<fullscreen>yes</fullscreen>','<fullscreen>no</fullscreen>')
    p.write_text(t)
" && DISPLAY=:1 openbox --reconfigure >/dev/null 2>&1 || true`;

export const MARK_CHROMIUM_CLEAN_SH = `python3 -c "import json
from pathlib import Path
p=Path('/config/chromium/Default/Preferences')
try:
    data=json.loads(p.read_text()) if p.exists() else {}
except Exception:
    data={}
if not isinstance(data, dict):
    data={}
prof=data.setdefault('profile', {})
if isinstance(prof, dict):
    prof['exit_type']='Normal'
    prof['exited_cleanly']=True
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, separators=(',', ':')))
" || true`;

export const DISMISS_RESTORE_SH =
  "DISPLAY=:1 xdotool search --name 'Restore pages' windowclose >/dev/null 2>&1 || true; " +
  "DISPLAY=:1 xdotool key Escape >/dev/null 2>&1 || true";

export async function relaxDeskWindowManager(deskId, { docker } = {}) {
  if (!docker?.exec) return false;
  await docker.exec(deskContainerName(deskId), ["sh", "-c", RELAX_OPENBOX_SH]);
  return true;
}

export async function markDeskChromiumClean(deskId, { docker } = {}) {
  if (!docker?.exec) return false;
  await docker.exec(deskContainerName(deskId), ["sh", "-c", MARK_CHROMIUM_CLEAN_SH]);
  return true;
}

export async function dismissDeskRestoreDialog(deskId, { docker } = {}) {
  if (!docker?.exec) return false;
  await docker.exec(deskContainerName(deskId), ["sh", "-c", DISMISS_RESTORE_SH]);
  return true;
}

export async function prepareAdminDesktop(
  deskId,
  {
    claimedTargetIds = [],
    listTargets = listDeskTargets,
    park = parkSeatTarget,
    pool = deskBrowsers,
    docker,
    connect,
    fetchImpl,
  } = {},
) {
  try {
    await relaxDeskWindowManager(deskId, { docker });
  } catch {
    /* live Openbox patch is best-effort */
  }
  try {
    await markDeskChromiumClean(deskId, { docker });
  } catch {
    /* prefs patch helps the next Chromium start */
  }

  const pages = await listTargets(deskId, fetchImpl, { connect, pool });
  const primary = pickPrimaryChatGPTTarget(pages, { claimedTargetIds });
  const parked = [];
  for (const t of pages) {
    if (!shouldParkForAdmin(t, { claimedTargetIds, primaryId: primary?.id })) continue;
    try {
      if (await park(deskId, t.id || t.targetId, { fetchImpl, connect, pool })) parked.push(t.id || t.targetId);
    } catch {
      /* keep going — raise still helps */
    }
  }

  const cdp = await pool.get(deskId, { fetchImpl, connect });
  if (primary?.id) {
    if (isMemberProjectUrl(primary.url) && !claimedTargetIds.includes(primary.id)) {
      try {
        await cdp.send("Target.activateTarget", { targetId: primary.id });
        const attached = await cdp.send("Target.attachToTarget", { targetId: primary.id, flatten: true });
        const sid = attached?.sessionId;
        if (sid) {
          await cdp.send("Page.navigate", { url: CHATGPT_START }, sid);
          await cdp.send("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
        }
      } catch {
        /* home navigation is best-effort */
      }
    }
    await raiseTargetWindow(cdp, primary.id);
    await dismissCrashRestore(cdp);
  }
  try {
    await dismissDeskRestoreDialog(deskId, { docker });
  } catch {
    /* xdotool is optional */
  }
  return { primaryId: primary?.id || "", parked };
}
