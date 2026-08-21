/**
 * Member /open: pick or create one exclusive tab target.
 * Never share a targetId. Never wait on a session-cookie probe.
 */
import { claimedSeatTargetIds, targetTakenError } from "./seats.mjs";

export const OPEN_CDP_MS = 4000;
export const OPEN_FAIL = "进入超时，请再试一次";
export const OPEN_TAB_FAIL = "无法进入分屏，请稍后再试";

export function memberCdpMustBeTab(cdp, role, mode) {
  return !(cdp && role !== "admin") || mode === "tab";
}

export async function allocateTabSeatTarget({
  deskId,
  user,
  projectUrl,
  startUrl,
  seats,
  existing,
  targetExists,
  findParked,
  createParked,
  reserveTarget,
} = {}) {
  if (!deskId || !user?.id) throw new Error("seat claim missing desk or user");

  const claimed = () => claimedSeatTargetIds(seats, deskId);

  if (existing?.mode === "tab" && existing.targetId) {
    const owners = (seats.list?.(deskId) || []).filter((s) => s.targetId === existing.targetId);
    const mine = owners.every((s) => s.userId === user.id);
    if (mine && (await targetExists(deskId, existing.targetId))) {
      return { targetId: existing.targetId, reused: true };
    }
  }

  const parked = typeof findParked === "function" ? await findParked(deskId, projectUrl, claimed()) : null;
  const parkedId = parked?.id || parked?.targetId;
  if (parkedId && !claimed().includes(parkedId) && reserveTarget?.(deskId, parkedId)) {
    return { targetId: parkedId, reused: true, adopted: true };
  }

  const created = await createParked(deskId, { claimedTargetIds: claimed(), startUrl });
  const targetId = created?.targetId;
  if (!targetId) throw new Error("无法创建分屏席位");
  if (claimed().includes(targetId)) throw targetTakenError();
  reserveTarget?.(deskId, targetId);
  return { targetId, reused: false };
}
