/**
 * 断开占用：撤销该用户的登录会话、清掉占用，并掐掉已建立的桌面连接。
 * 不改账号、不停用、不删人。
 */
export function createSocketHub() {
  const byUser = new Map();

  const forget = (userId, socket) => {
    const set = byUser.get(userId);
    if (!set) return;
    set.delete(socket);
    if (!set.size) byUser.delete(userId);
  };

  return {
    add(userId, socket) {
      if (!userId || !socket) return;
      if (!byUser.has(userId)) byUser.set(userId, new Set());
      byUser.get(userId).add(socket);
      const onDone = () => forget(userId, socket);
      if (typeof socket.on === "function") {
        socket.on("close", onDone);
        socket.on("end", onDone);
      }
    },
    drop(userId) {
      const set = byUser.get(userId);
      if (!set) return 0;
      const n = set.size;
      for (const socket of set) {
        try {
          if (typeof socket.destroy === "function") socket.destroy();
          else if (typeof socket.end === "function") socket.end();
        } catch {
          /* ignore */
        }
      }
      byUser.delete(userId);
      return n;
    },
    count(userId) {
      return byUser.get(userId)?.size || 0;
    },
  };
}

export function kickLiveSession({ sessions, presence, sockets }, userId) {
  const id = String(userId || "");
  if (!id) return { sessions: 0, sockets: 0 };
  const droppedSessions = sessions?.deleteByUser?.(id) || 0;
  presence?.leaveAll?.(id);
  const droppedSockets = sockets?.drop?.(id) || 0;
  return { sessions: droppedSessions, sockets: droppedSockets };
}
