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

export function chromiumExtraFlags({ startUrl, proxyUrl } = {}) {
  const flags = [`--app=${chromiumStartUrl(startUrl)}`];
  const proxy = rewriteProxyUrl(proxyUrl);
  if (proxy) flags.push(`--proxy-server=${proxy}`);
  return flags;
}
