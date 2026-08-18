import { instanceName } from "./instances.mjs";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const MAX_DESKS = 24;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export { MAX_DESKS };

export function nextDeskId(existing) {
  const taken = new Set(existing);
  for (const ch of LETTERS) {
    if (!taken.has(ch)) return ch;
  }
  for (let n = 2; n < 10000; n++) {
    for (const ch of LETTERS) {
      const id = `${ch}${n}`;
      if (!taken.has(id)) return id;
    }
  }
  throw new Error("没有可用的账号 id");
}

export function createDeskRegistry(seed) {
  const list = seed.map((i) => ({ ...i }));
  const byId = new Map(list.map((i) => [i.id, i]));
  return {
    all() {
      return [...list];
    },
    ids() {
      return list.map((i) => i.id);
    },
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    add(id) {
      if (byId.has(id)) return byId.get(id);
      const inst = { id, name: instanceName(id), target: `http://desktop-${id}:3000` };
      list.push(inst);
      byId.set(id, inst);
      return inst;
    },
  };
}

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** Start a real desktop container, then persist. Never persist a card without ensure(). */
export async function provisionDesk({ users, registry, ensure, name, id, maxDesks = MAX_DESKS }) {
  const n = String(name || "").trim();
  if (!n) throw fail("请给这个账号起个名字", 400);
  if (n.length > 24) throw fail("名字最多 24 个字符", 400);
  const taken = users.listDeskIds();
  if (taken.length >= maxDesks) throw fail(`最多 ${maxDesks} 个账号`, 400);
  let deskId = String(id || "").trim();
  if (deskId) {
    if (!ID_RE.test(deskId)) throw fail("账号 id 不合法", 400);
    if (taken.includes(deskId)) throw fail("账号已存在", 409);
  } else {
    deskId = nextDeskId(taken);
  }
  await ensure(deskId);
  const saved = users.addDesk(deskId, n);
  const inst = registry.add(deskId);
  return { id: deskId, name: saved.name || inst.name };
}
