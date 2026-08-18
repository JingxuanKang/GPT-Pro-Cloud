/** INSTANCES=a,b → [{ id, name, target }] */
export function instanceName(id) {
  if (id === "a") return "ChatGPT";
  if (id === "b") return "ChatGPT 2";
  return `ChatGPT ${id}`;
}

export function parseInstances(raw, targetFor = (id) => `http://desktop-${id}:3000`) {
  const ids = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length < 1) throw new Error("INSTANCES is empty");
  const seen = new Set();
  return ids.map((id) => {
    if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new Error(`bad instance id: ${id}`);
    if (seen.has(id)) throw new Error(`duplicate instance id: ${id}`);
    seen.add(id);
    return { id, name: instanceName(id), target: targetFor(id) };
  });
}
