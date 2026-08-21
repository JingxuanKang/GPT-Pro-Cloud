export function rewriteProxyUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  return s
    .replaceAll("127.0.0.1", "host.docker.internal")
    .replaceAll("localhost", "host.docker.internal")
    .replaceAll("[::1]", "host.docker.internal");
}

export const DEFAULT_START_URL = "https://chatgpt.com";

export function chromiumStartUrl(raw) {
  const s = String(raw ?? "").trim();
  return s || DEFAULT_START_URL;
}

export function chromiumExtraFlags({ startUrl, proxyUrl, cdp = false } = {}) {
  const url = chromiumStartUrl(startUrl);
  // --app exits when its only window is closed or tab-ified. Split-screen
  // seats need a normal window so extra Target.createTarget windows stay alive.
  const flags = cdp ? [url] : [`--app=${url}`];
  const proxy = rewriteProxyUrl(proxyUrl);
  if (proxy) flags.push(`--proxy-server=${proxy}`);
  return flags;
}

/** clipd POST /proxy — same live path as Settings per-desk save. */
export function deskClipdProxyUrl(id) {
  return `http://desktop-${id}:18790/proxy`;
}

export async function applyDeskProxyLive(id, proxy, fetchImpl = globalThis.fetch) {
  const r = await fetchImpl(deskClipdProxyUrl(id), {
    method: "POST",
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: String(proxy || ""),
  });
  if (!r.ok) throw new Error("proxy live apply failed");
}

export async function applyDeskProxiesLive(ids, proxy, fetchImpl = globalThis.fetch) {
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        await applyDeskProxyLive(id, proxy, fetchImpl);
        return { id, ok: true };
      } catch {
        return { id, ok: false };
      }
    }),
  );
  return { failed: results.filter((r) => !r.ok).map((r) => r.id) };
}
