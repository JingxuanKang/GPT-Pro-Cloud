const TTL_MS = 20_000;

export function createPresence() {
  /** deskId → Map<userId, { username, at }> */
  const rooms = new Map();

  const prune = (now = Date.now()) => {
    for (const [desk, people] of rooms) {
      for (const [uid, rec] of people) {
        if (now - rec.at > TTL_MS) people.delete(uid);
      }
      if (people.size === 0) rooms.delete(desk);
    }
  };

  return {
    beat(deskId, user, now = Date.now()) {
      if (!deskId || !user) return [];
      prune(now);
      if (!rooms.has(deskId)) rooms.set(deskId, new Map());
      rooms.get(deskId).set(user.id, { id: user.id, username: user.username, at: now });
      return this.list(deskId, now);
    },
    leave(deskId, userId) {
      rooms.get(deskId)?.delete(userId);
    },
    leaveAll(userId) {
      for (const people of rooms.values()) people.delete(userId);
    },
    desksOf(userId, now = Date.now()) {
      prune(now);
      if (!userId) return [];
      const ids = [];
      for (const [desk, people] of rooms) {
        if (people.has(userId)) ids.push(desk);
      }
      return ids;
    },
    list(deskId, now = Date.now()) {
      prune(now);
      const people = rooms.get(deskId);
      if (!people) return [];
      return [...people].map(([id, p]) => ({ id: p.id || id, username: p.username, at: p.at }));
    },
    all(now = Date.now()) {
      prune(now);
      const out = {};
      for (const [desk, people] of rooms) {
        out[desk] = [...people].map(([id, p]) => ({ id: p.id || id, username: p.username, at: p.at }));
      }
      return out;
    },
  };
}
