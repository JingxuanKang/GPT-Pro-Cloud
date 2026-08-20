import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  rewriteProxyUrl,
  chromiumStartUrl,
  chromiumExtraFlags,
  DEFAULT_START_URL,
  deskClipdProxyUrl,
  applyDeskProxyLive,
  applyDeskProxiesLive,
} from "../lib/proxy.mjs";
import { applyDeskCdpLive, chromiumCdpArgs, deskClipdCdpUrl, parseCdpFlag } from "../lib/cdp.mjs";
import {
  requirePasswordConfigured,
  hashPassword,
  passwordMatches,
  needsRehash,
  createSessionToken,
  readSession,
  createLoginLimiter,
} from "../lib/auth.mjs";
import { scryptSync } from "node:crypto";
import { parseInstances } from "../lib/instances.mjs";

describe("rewriteProxyUrl", () => {
  it("keeps empty proxy empty", () => {
    assert.equal(rewriteProxyUrl(""), "");
    assert.equal(rewriteProxyUrl("   "), "");
    assert.equal(rewriteProxyUrl(undefined), "");
  });

  it("rewrites loopback HTTP and SOCKS hosts", () => {
    assert.equal(rewriteProxyUrl("http://127.0.0.1:7890"), "http://host.docker.internal:7890");
    assert.equal(rewriteProxyUrl("socks5://localhost:7891"), "socks5://host.docker.internal:7891");
    assert.equal(rewriteProxyUrl("http://[::1]:7890"), "http://host.docker.internal:7890");
  });
});

describe("chromium flags", () => {
  it("defaults to ChatGPT", () => {
    assert.equal(chromiumStartUrl(""), DEFAULT_START_URL);
    assert.equal(DEFAULT_START_URL, "https://chatgpt.com");
  });

  it("passes rewritten proxy to --proxy-server", () => {
    const flags = chromiumExtraFlags({ startUrl: "https://chatgpt.com", proxyUrl: "http://127.0.0.1:7890" });
    assert.ok(flags.includes("--app=https://chatgpt.com"));
    assert.ok(flags.includes("--proxy-server=http://host.docker.internal:7890"));
  });

  it("omits remote-debugging flags unless CDP is on", () => {
    assert.deepEqual(chromiumCdpArgs(false), []);
    assert.deepEqual(chromiumCdpArgs(true), [
      "--remote-debugging-port=9222",
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
    ]);
    assert.equal(parseCdpFlag(""), false);
    assert.equal(parseCdpFlag("0"), false);
    assert.equal(parseCdpFlag("1"), true);
    assert.equal(deskClipdCdpUrl("a"), "http://desktop-a:18790/cdp");
  });

  it("pushes a CDP toggle to clipd so Chromium restarts with or without the debug port", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      return { ok: true };
    };
    await applyDeskCdpLive("a", true, fetchImpl);
    await applyDeskCdpLive("b", false, fetchImpl);
    assert.equal(calls[0].url, "http://desktop-a:18790/cdp");
    assert.equal(calls[0].body, "1");
    assert.equal(calls[1].url, "http://desktop-b:18790/cdp");
    assert.equal(calls[1].body, "0");
  });

  it("pushes a proxy to clipd for one desk and for every desk", async () => {
    assert.equal(deskClipdProxyUrl("c"), "http://desktop-c:18790/proxy");
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      return { ok: url.includes("desktop-b") ? false : true };
    };
    await applyDeskProxyLive("a", "http://127.0.0.1:7890", fetchImpl);
    const { failed } = await applyDeskProxiesLive(["a", "b"], "socks5://10.0.0.2:1080", fetchImpl);
    assert.deepEqual(failed, ["b"]);
    assert.equal(calls[0].url, "http://desktop-a:18790/proxy");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body, "http://127.0.0.1:7890");
    assert.equal(calls.length, 3);
    assert.ok(calls.slice(1).every((c) => c.body === "socks5://10.0.0.2:1080"));
    assert.deepEqual(
      calls.slice(1).map((c) => c.url).sort(),
      ["http://desktop-a:18790/proxy", "http://desktop-b:18790/proxy"],
    );
  });
});

describe("auth", () => {
  it("refuses empty password", () => {
    assert.throws(() => requirePasswordConfigured(""), /empty/);
    assert.throws(() => requirePasswordConfigured("  "), /empty/);
  });

  it("rejects a wrong password and accepts the configured one", () => {
    const expected = hashPassword("unit-login-pass");
    assert.equal(passwordMatches("wrong-password", expected), false);
    assert.equal(passwordMatches("unit-login-pass", expected), true);
    const sessions = new Map();
    const token = createSessionToken();
    sessions.set(token, { expires: Date.now() + 60_000 });
    assert.equal(readSession(sessions, token).expires > Date.now(), true);
    assert.equal(readSession(sessions, "nope"), null);
  });

  it("salts every hash and flags the legacy format for rehash", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    assert.notEqual(a, b);
    assert.equal(needsRehash(a), false);
    const legacy = scryptSync("old-pass", "gpc-v0", 32).toString("base64");
    assert.equal(needsRehash(legacy), true);
    assert.equal(passwordMatches("old-pass", legacy), true);
    assert.equal(passwordMatches("wrong", legacy), false);
  });

  it("locks a key after repeated login failures and resets on success", () => {
    const limiter = createLoginLimiter({ maxFails: 3, windowMs: 1000 });
    const now = 1_000_000;
    assert.equal(limiter.blocked("ip|u", now), false);
    limiter.fail("ip|u", now);
    limiter.fail("ip|u", now);
    assert.equal(limiter.blocked("ip|u", now), false);
    limiter.fail("ip|u", now);
    assert.equal(limiter.blocked("ip|u", now), true);
    assert.equal(limiter.blocked("ip|other", now), false);
    assert.equal(limiter.blocked("ip|u", now + 1001), false);
    limiter.fail("ip|u", now + 2000);
    limiter.ok("ip|u");
    assert.equal(limiter.blocked("ip|u", now + 2000), false);
  });
});

describe("instances", () => {
  it("parses two isolated desktops", () => {
    const list = parseInstances("a,b");
    assert.equal(list.length, 2);
    assert.equal(list[0].id, "a");
    assert.equal(list[1].id, "b");
    assert.equal(list[0].target, "http://desktop-a:3000");
    assert.equal(list[0].name, "ChatGPT");
    assert.equal(list[1].name, "ChatGPT 2");
    assert.notEqual(list[0].target, list[1].target);
  });
});
