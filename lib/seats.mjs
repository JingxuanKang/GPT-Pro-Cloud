/**
 * Per-member tab seats on one Chromium profile.
 * VNC stays the first-login / first-occupant path. Extra members get a
 * chatgpt.com tab streamed via CDP — they never receive other targets.
 */
import { randomUUID } from "node:crypto";

export const DEFAULT_TAB_SEAT_CAP = 3;
export const TAB_SEAT_IDLE_MS = 45_000;

export function parseTabSeatCap(raw, fallback = DEFAULT_TAB_SEAT_CAP) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 8) return fallback;
  return n;
}

export function seatCapError(cap) {
  const e = new Error(`这个账号同时最多 ${cap} 个分屏席位`);
  e.code = "SEAT_CAP";
  e.status = 409;
  return e;
}

export function multiUserOffError() {
  const e = new Error("这个号未开多人分屏，请管理员开启");
  e.code = "CDP_OFF";
  e.status = 409;
  return e;
}

/**
 * Decide how a member should enter a desk.
 * - Same member already seated → attach that seat (no second tab).
 * - Desk empty → exclusive VNC (first occupant / first-time ChatGPT login).
 * - Someone else is already on the desk:
 *   - CDP / 多人分屏 off → reject (do not share one VNC mouse).
 *   - CDP on → new tab seat.
 *
 * hasSession is true / false / null (probe failed). A failed or negative
 * cookie probe must not force a second VNC — phoenix/#10 swallowed
 * "无法连接页面" as hasSession=false and both users got mode:"vnc".
 */
export function decideOpenMode({ occupants = [], userId, tabCount = 0, cap = DEFAULT_TAB_SEAT_CAP, existing, cdp = false, hasSession = null } = {}) {
  if (existing) return { mode: existing.mode, attach: true, seat: existing };
  const others = occupants.filter((o) => o.userId && o.userId !== userId);
  if (others.length === 0) return { mode: "vnc", attach: false };
  if (!cdp) throw multiUserOffError();
  if (tabCount >= cap) throw seatCapError(cap);
  // Occupied + CDP → tab even when hasSession is false or null (probe failed).
  return { mode: "tab", attach: false, hasSession };
}

/** Client-safe seat. Never includes targetId or debugger URLs. */
export function publicSeat(seat) {
  if (!seat) return null;
  return {
    id: seat.id,
    deskId: seat.deskId,
    mode: seat.mode,
    userId: seat.userId,
    username: seat.username,
  };
}

/** Isolation: a seat may only observe its own CDP target. */
export function targetsVisibleToSeat(seat, targets) {
  if (!seat?.targetId) return [];
  return (targets || [])
    .filter((t) => t && t.id === seat.targetId)
    .map((t) => ({ id: t.id, type: t.type || "page" }));
}

export function createSeatRegistry({ cap = DEFAULT_TAB_SEAT_CAP, idleMs = TAB_SEAT_IDLE_MS } = {}) {
  /** deskId → Map<seatId, seat> */
  const rooms = new Map();

  const list = (deskId) => [...(rooms.get(deskId)?.values() || [])];

  const forget = (seat) => {
    const room = rooms.get(seat.deskId);
    if (!room) return;
    room.delete(seat.id);
    if (room.size === 0) rooms.delete(seat.deskId);
  };

  return {
    cap,
    idleMs,
    decide(deskId, user, { cdp = false, hasSession = null, extraOccupants = [] } = {}) {
      const seats = list(deskId);
      const existing = seats.find((s) => s.userId === user.id);
      const tabCount = seats.filter((s) => s.mode === "tab" && s.userId !== user.id).length;
      const seen = new Set();
      const occupants = [];
      for (const o of [...seats, ...extraOccupants]) {
        const uid = o.userId || o.id;
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        occupants.push({ userId: uid });
      }
      return decideOpenMode({
        occupants,
        userId: user.id,
        tabCount,
        cap,
        existing,
        cdp,
        hasSession,
      });
    },
    claim(deskId, user, { mode, targetId, now = Date.now() } = {}) {
      if (!deskId || !user?.id) throw new Error("seat claim missing desk or user");
      const existing = list(deskId).find((s) => s.userId === user.id);
      if (existing) {
        existing.lastBeat = now;
        if (mode) existing.mode = mode;
        if (targetId) existing.targetId = targetId;
        return existing;
      }
      if (mode === "tab") {
        const tabCount = list(deskId).filter((s) => s.mode === "tab").length;
        if (tabCount >= cap) throw seatCapError(cap);
      }
      const seat = {
        id: randomUUID(),
        deskId,
        userId: user.id,
        username: user.username,
        mode: mode || "vnc",
        targetId: targetId || null,
        createdAt: now,
        lastBeat: now,
      };
      if (!rooms.has(deskId)) rooms.set(deskId, new Map());
      rooms.get(deskId).set(seat.id, seat);
      return seat;
    },
    get(seatId) {
      if (!seatId) return undefined;
      for (const room of rooms.values()) {
        if (room.has(seatId)) return room.get(seatId);
      }
      return undefined;
    },
    ofUser(deskId, userId) {
      return list(deskId).find((s) => s.userId === userId);
    },
    beat(seatId, now = Date.now()) {
      const seat = this.get(seatId);
      if (seat) seat.lastBeat = now;
      return seat;
    },
    release(seatId) {
      const seat = this.get(seatId);
      if (!seat) return undefined;
      forget(seat);
      return seat;
    },
    releaseByUser(userId) {
      const dropped = [];
      if (!userId) return dropped;
      for (const room of rooms.values()) {
        for (const seat of [...room.values()]) {
          if (seat.userId === userId) {
            forget(seat);
            dropped.push(seat);
          }
        }
      }
      return dropped;
    },
    releaseDesk(deskId) {
      const dropped = list(deskId);
      rooms.delete(deskId);
      return dropped;
    },
    idleTabs(now = Date.now()) {
      const stale = [];
      for (const room of rooms.values()) {
        for (const seat of room.values()) {
          if (seat.mode === "tab" && now - seat.lastBeat > idleMs) stale.push(seat);
        }
      }
      return stale;
    },
    list,
    tabCount(deskId) {
      return list(deskId).filter((s) => s.mode === "tab").length;
    },
  };
}
